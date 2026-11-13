// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
    checkIpcCommands,
    readPluginCommandWhitelist,
    readPluginNames,
    readRustCommands,
    stripRustComments,
    validatePluginCommandWhitelist,
} from '../../../scripts/ci/architecture/check-ipc-commands.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(testDirectory, 'fixtures/ipc');
const FIXTURE_SUFFIX = '.fixture';

const cleanup: string[] = [];

function copyFixtureTree(source: string, target: string): void {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = entry.name.endsWith(FIXTURE_SUFFIX)
            ? path.join(target, entry.name.slice(0, -FIXTURE_SUFFIX.length))
            : path.join(target, entry.name);
        if (entry.isDirectory()) copyFixtureTree(from, to);
        else fs.copyFileSync(from, to);
    }
}

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-ipc-'));
cleanup.push(projectRoot);
copyFixtureTree(FIXTURE, projectRoot);
const whitelistFile = path.join(projectRoot, 'whitelist.json');

afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const result = checkIpcCommands({ projectRoot, whitelistFile });
const unknownCommands: string[] = result.unknown.map((invoke) => invoke.command);

function createRustHandlerProject(source: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-rust-handler-'));
    cleanup.push(root);
    const handlerFile = path.join(root, 'apps/desktop/src-tauri/src/commands/mod.rs');
    fs.mkdirSync(path.dirname(handlerFile), { recursive: true });
    fs.writeFileSync(handlerFile, source);
    return root;
}

describe('user runs the IPC presence gate over an isolated crate and service', () => {
    describe('given a NativeService invoke named in the Rust handler list', () => {
        it('user sees it accepted', () => {
            expect(unknownCommands).not.toContain('known_cmd');
        });
    });

    describe('given a NativeService invoke with no Rust handler', () => {
        it('user sees it flagged', () => {
            expect(unknownCommands).toContain('missing_cmd');
        });
    });

    describe('given an aliased invoke import with an unknown command', () => {
        it('user sees it flagged', () => {
            expect(unknownCommands).toContain('alias_missing_cmd');
        });
    });

    describe('given a namespace invoke import with a registered command', () => {
        it('user sees it accepted', () => {
            expect(unknownCommands).not.toContain('ns_known_cmd');
        });
    });

    describe('given a bare Rust handler function name', () => {
        it('user sees the bare name accepted', () => {
            expect(unknownCommands).not.toContain('bare_cmd');
        });
    });

    describe('given a plugin command from a registered plugin', () => {
        it('user sees it accepted', () => {
            expect(unknownCommands).not.toContain('plugin:log|log');
        });
    });

    describe('given a misspelled command from a registered plugin', () => {
        it('user sees it flagged because the whitelist is per command', () => {
            expect(unknownCommands).toContain('plugin:log|wrong');
        });
    });

    describe('given a plugin command from an unregistered plugin', () => {
        it('user sees it flagged', () => {
            expect(unknownCommands).toContain('plugin:bogus|x');
        });
    });

    describe('given a nested wrapper that invokes with a variable command', () => {
        it('user sees it reported as unresolved instead of ignored', () => {
            expect(result.dynamic).toHaveLength(1);
            expect(unknownCommands).toContain('<dynamic>');
        });
    });

    describe('given the canonical NativeService bridge forwards a variable command', () => {
        it('user does not get the bridge itself reported as an unresolved call site', () => {
            expect(
                result.dynamic.some((entry) => entry.file.endsWith('/NativeService/invoke.ts'))
            ).toBe(false);
        });
    });

    describe('given a NativeService module calls a literal command through the bridge', () => {
        it('user sees the command resolved through the bridge import', () => {
            expect(result.invokes).toContainEqual(
                expect.objectContaining({
                    command: 'plugin:log|log',
                    file: 'apps/desktop/src/services/NativeService/log.ts',
                })
            );
        });
    });

    it('user sees every static NativeService invoke accounted for', () => {
        expect(result.invokes).toHaveLength(10);
    });

    describe('given a Rust handler list with commented-out commands', () => {
        it('user sees only active commands registered', () => {
            const commands = readRustCommands(projectRoot);
            expect(commands.has('known_cmd')).toBe(true);
            expect(commands.has('ghost_cmd')).toBe(false);
            expect(commands.has('block_ghost_cmd')).toBe(false);
            expect(commands.has('fake_before_real')).toBe(false);
            expect(commands.has('fake_in_string')).toBe(false);
        });
    });

    it('user sees the Rust handler names parsed', () => {
        expect([...readRustCommands(projectRoot)]).toEqual(
            expect.arrayContaining(['known_cmd', 'other_cmd', 'ns_known_cmd', 'bare_cmd'])
        );
    });

    describe('given Rust comments and strings containing comment markers', () => {
        it('user sees strings preserved and comments removed with newlines kept', () => {
            const stripped = stripRustComments(
                'const URL: &str = "https://example.test/#fragment"; // fake ]\n/* fake [\n*/ fn main() {}'
            );

            expect(stripped).toContain('"https://example.test/#fragment"');
            expect(stripped).not.toContain('fake ]');
            expect(stripped).not.toContain('fake [');
            expect(stripped).toContain('\n\n');
        });
    });

    describe('given an unknown handler token', () => {
        it('user sees the gate fail instead of silently ignoring it', () => {
            const root = createRustHandlerProject(
                'pub fn invoke_handler() { tauri::generate_handler![alpha::known_cmd as u8]; }'
            );

            expect(() => readRustCommands(root)).toThrow(
                "Unsupported generate_handler entry: 'alpha::known_cmd as u8'"
            );
        });
    });

    it('user sees the plugin names parsed from Cargo.toml', () => {
        expect([...readPluginNames(projectRoot)]).toContain('log');
    });

    it('user sees the exact plugin command whitelist loaded', () => {
        expect(Object.keys(readPluginCommandWhitelist(whitelistFile))).toEqual(['plugin:log|log']);
    });

    it('user sees no whitelist configuration error', () => {
        expect(result.whitelistErrors).toEqual([]);
    });

    describe('given a whitelist entry whose source is absent or does not call the command', () => {
        it('user sees a whitelist configuration error', () => {
            const errors = validatePluginCommandWhitelist(
                projectRoot,
                {
                    'plugin:log|log': {
                        source: 'apps/desktop/src/services/NativeService/alias.ts',
                        reason: 'source exists but never invokes this command',
                    },
                    'plugin:log|wrong': {
                        source: 'apps/desktop/src/services/NativeService/absent.ts',
                        reason: 'source file is missing',
                    },
                    'plugin:log|bare': { reason: 'no source documented' },
                },
                readPluginNames(projectRoot)
            );

            expect(errors).toContain(
                "plugin:log|log source 'apps/desktop/src/services/NativeService/alias.ts' does not invoke plugin:log|log"
            );
            expect(errors).toContain(
                "plugin:log|wrong source 'apps/desktop/src/services/NativeService/absent.ts' does not exist"
            );
            expect(errors).toContain('plugin:log|bare has no source');
        });
    });

    describe('given a plugin command that only appears in a comment or constant', () => {
        it('user sees the source rejected because no static invoke calls the command', () => {
            const errors = validatePluginCommandWhitelist(
                projectRoot,
                {
                    'plugin:log|log': {
                        source: 'apps/desktop/src/services/NativeService/comment-source.ts',
                        reason: 'the command appears without a static invoke',
                    },
                },
                readPluginNames(projectRoot)
            );

            expect(errors).toContain(
                "plugin:log|log source 'apps/desktop/src/services/NativeService/comment-source.ts' does not invoke plugin:log|log"
            );
        });
    });
});
