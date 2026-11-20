// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
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
} from '../../../tooling/architecture/check-ipc-commands.mjs';

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

function isolatedProject(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-ipc-case-'));
    cleanup.push(root);
    copyFixtureTree(FIXTURE, root);
    return root;
}

describe('user checks native commands after moving application code', () => {
    it('user gets a failing command exit when an adapter root disappeared', () => {
        const root = isolatedProject();
        fs.rmSync(path.join(root, 'apps/desktop/src/platform/native'), { recursive: true });
        const cli = path.resolve(
            testDirectory,
            '../../../tooling/architecture/check-ipc-commands.mjs'
        );
        const result = spawnSync(
            process.execPath,
            [cli, '--project-root', root, '--whitelist', whitelistFile],
            { encoding: 'utf8' }
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Native adapter root is missing or empty');
    });

    it.each(['missing', 'empty'])(
        'user sees a failure when the required adapter root is %s',
        (kind) => {
            const root = isolatedProject();
            const directory = path.join(root, 'apps/desktop/src/platform/native');
            fs.rmSync(directory, { recursive: true });
            if (kind === 'empty') fs.mkdirSync(directory);
            expect(() => checkIpcCommands({ projectRoot: root, whitelistFile })).toThrow(
                /native.*missing|native.*empty/i
            );
        }
    );

    it.each([
        "import { invoke as call } from '@/platform/native/invoke'; call('alias_unknown');",
        "import { invoke as call } from './invoke.js'; call('alias_unknown');",
        "import * as bridge from './invoke'; bridge.invoke('alias_unknown');",
        "import * as bridge from './invoke'; bridge['invoke']('alias_unknown');",
    ])('user sees an unregistered command through a supported import reported: %s', (source) => {
        const root = isolatedProject();
        fs.writeFileSync(path.join(root, 'apps/desktop/src/platform/native/extra.ts'), source);
        const result = checkIpcCommands({ projectRoot: root, whitelistFile });
        expect(result.unknown).toContainEqual(
            expect.objectContaining({ command: 'alias_unknown' })
        );
    });

    it('user sees an unregistered bridge command reported outside the adapter directory', () => {
        const root = isolatedProject();
        fs.writeFileSync(
            path.join(root, 'apps/desktop/src/caller.ts'),
            "import { invoke } from '@/platform/native/invoke'; invoke('outside_unknown');"
        );
        expect(checkIpcCommands({ projectRoot: root, whitelistFile }).unknown).toContainEqual(
            expect.objectContaining({ command: 'outside_unknown' })
        );
    });

    it('user sees no false command from a parameter that shadows an imported bridge', () => {
        const root = isolatedProject();
        fs.writeFileSync(
            path.join(root, 'apps/desktop/src/platform/native/extra.ts'),
            "import { invoke } from './invoke'; export function run(invoke: (value: string) => void) { invoke('not_native'); }"
        );
        expect(checkIpcCommands({ projectRoot: root, whitelistFile }).invokes).not.toContainEqual(
            expect.objectContaining({ command: 'not_native' })
        );
    });

    it('user sees an error when the plugin command policy is missing', () => {
        expect(() =>
            checkIpcCommands({ projectRoot, whitelistFile: path.join(projectRoot, 'absent.json') })
        ).toThrow();
    });

    it('user can reexport native file URLs without granting command invocation', () => {
        const root = isolatedProject();
        fs.writeFileSync(
            path.join(root, 'apps/desktop/src/platform/native/extra.ts'),
            "export { convertFileSrc } from '@tauri-apps/api/core';"
        );
        expect(checkIpcCommands({ projectRoot: root, whitelistFile }).dynamic).not.toContainEqual(
            expect.objectContaining({ file: 'apps/desktop/src/platform/native/extra.ts' })
        );
    });

    it.each([
        "import { invoke } from './invoke'; const call = invoke; call('hidden');",
        "export { invoke as call } from './invoke';",
        "const bridge = await import('./invoke'); bridge.invoke('hidden');",
        "const bridge = await import(`./invoke`); bridge.invoke('hidden');",
        "const bridge = import.meta.glob('./invoke.ts', { eager: true, import: 'invoke' }); bridge['./invoke.ts']('hidden');",
        "const bridge = require('./invoke'); bridge.invoke('hidden');",
        "import bridge = require('./invoke'); bridge.invoke('hidden');",
    ])('user sees indirect bridge use fail closed: %s', (source) => {
        const root = isolatedProject();
        fs.writeFileSync(path.join(root, 'apps/desktop/src/platform/native/extra.ts'), source);
        expect(checkIpcCommands({ projectRoot: root, whitelistFile }).dynamic).toContainEqual(
            expect.objectContaining({ file: 'apps/desktop/src/platform/native/extra.ts' })
        );
    });

    it.each([
        "import { invoke } from './invoke'; export type Call = typeof invoke;",
        "import * as bridge from './invoke'; export type Call = typeof bridge.invoke;",
        "import { invoke } from './invoke'; export type { invoke };",
    ])('user can describe a native call type without invoking it: %s', (source) => {
        const root = isolatedProject();
        fs.writeFileSync(path.join(root, 'apps/desktop/src/platform/native/extra.ts'), source);
        expect(checkIpcCommands({ projectRoot: root, whitelistFile }).dynamic).not.toContainEqual(
            expect.objectContaining({ file: 'apps/desktop/src/platform/native/extra.ts' })
        );
    });

    it('user sees a plugin grant restricted to its reviewed caller', () => {
        const root = isolatedProject();
        fs.writeFileSync(
            path.join(root, 'apps/desktop/src/platform/native/extra.ts'),
            "import { invoke } from './invoke'; invoke('plugin:log|log');"
        );
        expect(checkIpcCommands({ projectRoot: root, whitelistFile }).unknown).toContainEqual(
            expect.objectContaining({
                command: 'plugin:log|log',
                file: 'apps/desktop/src/platform/native/extra.ts',
            })
        );
    });

    it('user sees a failure when no native calls remain to inspect', () => {
        const root = isolatedProject();
        const directory = path.join(root, 'apps/desktop/src/platform/native');
        const bridge = fs.readFileSync(path.join(directory, 'invoke.ts'));
        fs.rmSync(directory, { recursive: true });
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'invoke.ts'), bridge);
        expect(() => checkIpcCommands({ projectRoot: root, whitelistFile })).toThrow(
            /no native calls/i
        );
    });
});

describe('user runs the IPC presence gate over an isolated crate and service', () => {
    describe('given a native adapter invoke named in the Rust handler list', () => {
        it('user sees it accepted', () => {
            expect(unknownCommands).not.toContain('known_cmd');
        });
    });

    describe('given a native adapter invoke with no Rust handler', () => {
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

    describe('given the canonical native adapter bridge forwards a variable command', () => {
        it('user does not get the bridge itself reported as an unresolved call site', () => {
            expect(result.dynamic.some((entry) => entry.file.endsWith('/native/invoke.ts'))).toBe(
                false
            );
        });
    });

    describe('given a native adapter module calls a literal command through the bridge', () => {
        it('user sees the command resolved through the bridge import', () => {
            expect(result.invokes).toContainEqual(
                expect.objectContaining({
                    command: 'plugin:log|log',
                    file: 'apps/desktop/src/platform/native/log.ts',
                })
            );
        });
    });

    it('user sees every static native adapter invoke accounted for', () => {
        expect(result.invokes).toHaveLength(9);
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
                        source: 'apps/desktop/src/platform/native/alias.ts',
                        reason: 'source exists but never invokes this command',
                    },
                    'plugin:log|wrong': {
                        source: 'apps/desktop/src/platform/native/absent.ts',
                        reason: 'source file is missing',
                    },
                    'plugin:log|bare': { reason: 'no source documented' },
                },
                readPluginNames(projectRoot)
            );

            expect(errors).toContain(
                "plugin:log|log source 'apps/desktop/src/platform/native/alias.ts' does not invoke plugin:log|log"
            );
            expect(errors).toContain(
                "plugin:log|wrong source 'apps/desktop/src/platform/native/absent.ts' does not exist"
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
                        source: 'apps/desktop/src/platform/native/comment-source.ts',
                        reason: 'the command appears without a static invoke',
                    },
                },
                readPluginNames(projectRoot)
            );

            expect(errors).toContain(
                "plugin:log|log source 'apps/desktop/src/platform/native/comment-source.ts' does not invoke plugin:log|log"
            );
        });
    });
});
