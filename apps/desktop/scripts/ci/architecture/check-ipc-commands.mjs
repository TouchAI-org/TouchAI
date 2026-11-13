// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * IPC static presence gate.
 *
 * Every `invoke(...)` under `NativeService` (recursively, including aliased and
 * namespace imports) must name a command that the Rust side registers in
 * `generate_handler!`, or an EXACT entry in `ipc-plugin-commands.json`
 * (plugin commands are allow-listed per command, never per plugin). A plugin
 * allow-list entry is only valid when its plugin is a registered Cargo
 * dependency.
 *
 * A unit that calls `invoke()` with a value that cannot be proven statically is
 * reported as unresolved, not silently ignored. This is a PRESENCE check, not
 * an equality check and not a decoder contract test: it never requires the
 * wrapper set to equal the handler list, never asserts argument casing, and does
 * not replace the Rust/IPC decoder tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as tseslint from 'typescript-eslint';

import { PROJECT_ROOT } from './boundaries.mjs';

export const NATIVE_SERVICE_DIR = 'apps/desktop/src/services/NativeService';
export const RUST_HANDLER_FILE = 'apps/desktop/src-tauri/src/commands/mod.rs';
export const CARGO_TOML_FILE = 'apps/desktop/src-tauri/Cargo.toml';
const PLUGIN_WHITELIST_FILE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'ipc-plugin-commands.json'
);

const TAURI_API_PREFIX = '@tauri-apps/api';

function walk(node, visitorKeys, visit) {
    if (node === null || typeof node !== 'object' || typeof node.type !== 'string') return;
    visit(node);
    for (const key of visitorKeys[node.type] ?? []) {
        const child = node[key];
        if (Array.isArray(child)) {
            for (const item of child) walk(item, visitorKeys, visit);
        } else if (child !== null && typeof child === 'object') {
            walk(child, visitorKeys, visit);
        }
    }
}

function listTsFiles(root) {
    const files = [];
    if (!fs.existsSync(root)) return files;
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
        }
    }
    return files.sort();
}

/**
 * Remove Rust line comments and block comments so a command that only exists in
 * a commented-out line is not counted as registered. String literals are kept
 * intact; newlines inside block comments are preserved so diagnostics and the
 * handler scan still use the same source layout.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripRustComments(source) {
    let output = '';
    let index = 0;

    while (index < source.length) {
        const current = source[index];
        const next = source[index + 1];

        if (current === '/' && next === '/') {
            index += 2;
            while (index < source.length && source[index] !== '\n') index += 1;
            continue;
        }

        if (current === '/' && next === '*') {
            let depth = 1;
            index += 2;
            while (index < source.length && depth > 0) {
                if (source[index] === '/' && source[index + 1] === '*') {
                    depth += 1;
                    index += 2;
                } else if (source[index] === '*' && source[index + 1] === '/') {
                    depth -= 1;
                    index += 2;
                } else {
                    if (source[index] === '\n') output += '\n';
                    index += 1;
                }
            }
            continue;
        }

        const rawStringEnd = rustRawStringEnd(source, index);
        if (rawStringEnd !== null) {
            output += source.slice(index, rawStringEnd);
            index = rawStringEnd;
            continue;
        }

        if (current === '"') {
            const end = rustQuotedEnd(source, index, '"');
            output += source.slice(index, end);
            index = end;
            continue;
        }

        if (current === "'") {
            const charEnd = rustCharEnd(source, index);
            if (charEnd !== null) {
                output += source.slice(index, charEnd);
                index = charEnd;
                continue;
            }
        }

        output += current;
        index += 1;
    }

    return output;
}

function rustRawStringEnd(source, start) {
    let cursor = start;
    if (source[cursor] === 'b' || source[cursor] === 'c') cursor += 1;
    if (source[cursor] !== 'r') return null;
    cursor += 1;
    let hashes = 0;
    while (source[cursor] === '#') {
        hashes += 1;
        cursor += 1;
    }
    if (source[cursor] !== '"') return null;
    const closing = `"${'#'.repeat(hashes)}`;
    const end = source.indexOf(closing, cursor + 1);
    return end === -1 ? source.length : end + closing.length;
}

function rustQuotedEnd(source, start, quote) {
    let cursor = start + 1;
    while (cursor < source.length) {
        if (source[cursor] === '\\') {
            cursor += 2;
            continue;
        }
        if (source[cursor] === quote) return cursor + 1;
        cursor += 1;
    }
    return source.length;
}

function rustCharEnd(source, start) {
    let cursor = start + 1;
    if (cursor >= source.length) return null;
    if (source[cursor] === '\\') {
        cursor += 2;
    } else {
        cursor += 1;
    }
    return source[cursor] === "'" ? cursor + 1 : null;
}

function findGenerateHandlerBodyStart(source) {
    const marker = 'generate_handler';
    let index = 0;
    while (index < source.length) {
        const rawStringEnd = rustRawStringEnd(source, index);
        if (rawStringEnd !== null) {
            index = rawStringEnd;
            continue;
        }
        if (source[index] === '"') {
            index = rustQuotedEnd(source, index, '"');
            continue;
        }
        if (source[index] === "'") {
            const charEnd = rustCharEnd(source, index);
            if (charEnd !== null) {
                index = charEnd;
                continue;
            }
        }
        if (!source.startsWith(marker, index)) {
            index += 1;
            continue;
        }

        let cursor = index + marker.length;
        while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
        if (source[cursor] !== '!') {
            index = cursor;
            continue;
        }
        cursor += 1;
        while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
        if (source[cursor] === '[') {
            return cursor + 1;
        }
        index = cursor;
    }
    return null;
}

function findClosingBracket(source, start) {
    let depth = 1;
    let index = start;
    while (index < source.length) {
        const rawStringEnd = rustRawStringEnd(source, index);
        if (rawStringEnd !== null) {
            index = rawStringEnd;
            continue;
        }
        if (source[index] === '"') {
            index = rustQuotedEnd(source, index, '"');
            continue;
        }
        if (source[index] === "'") {
            const charEnd = rustCharEnd(source, index);
            if (charEnd !== null) {
                index = charEnd;
                continue;
            }
        }
        if (source[index] === '[') depth += 1;
        else if (source[index] === ']') {
            depth -= 1;
            if (depth === 0) return index;
        }
        index += 1;
    }
    return -1;
}

function splitRustHandlerEntries(body) {
    const entries = [];
    let start = 0;
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let index = 0;

    while (index < body.length) {
        const rawStringEnd = rustRawStringEnd(body, index);
        if (rawStringEnd !== null) {
            index = rawStringEnd;
            continue;
        }
        if (body[index] === '"') {
            index = rustQuotedEnd(body, index, '"');
            continue;
        }
        if (body[index] === "'") {
            const charEnd = rustCharEnd(body, index);
            if (charEnd !== null) {
                index = charEnd;
                continue;
            }
        }
        if (body[index] === '(') parenDepth += 1;
        else if (body[index] === ')') parenDepth -= 1;
        else if (body[index] === '{') braceDepth += 1;
        else if (body[index] === '}') braceDepth -= 1;
        else if (body[index] === '[') bracketDepth += 1;
        else if (body[index] === ']') bracketDepth -= 1;
        else if (
            body[index] === ',' &&
            parenDepth === 0 &&
            braceDepth === 0 &&
            bracketDepth === 0
        ) {
            entries.push(body.slice(start, index));
            start = index + 1;
        }
        index += 1;
    }
    entries.push(body.slice(start));
    return entries;
}

const RUST_IDENTIFIER = String.raw`(?:r#)?[A-Za-z_][A-Za-z0-9_]*`;
const RUST_HANDLER_PATH = new RegExp(
    String.raw`^${RUST_IDENTIFIER}(?:\s*::\s*${RUST_IDENTIFIER})*$`,
    'u'
);

function parseRustHandlerEntry(entry) {
    const value = entry.trim();
    if (!RUST_HANDLER_PATH.test(value)) {
        throw new Error(`Unsupported generate_handler entry: '${value}'`);
    }
    return value.split('::').at(-1)?.trim().replace(/^r#/u, '') ?? '';
}

/**
 * @param {string} [projectRoot]
 * @returns {Set<string>} command function names registered by `generate_handler!`
 */
export function readRustCommands(projectRoot = PROJECT_ROOT) {
    const source = fs.readFileSync(path.join(projectRoot, RUST_HANDLER_FILE), 'utf8');
    const stripped = stripRustComments(source);
    const start = findGenerateHandlerBodyStart(stripped);
    if (start === null) throw new Error(`generate_handler! not found in ${RUST_HANDLER_FILE}`);
    const end = findClosingBracket(stripped, start);
    if (end === -1) {
        throw new Error(`generate_handler! has no closing bracket in ${RUST_HANDLER_FILE}`);
    }
    const body = stripped.slice(start, end);

    const commands = new Set();
    for (const entry of splitRustHandlerEntries(body)) {
        if (entry.trim() === '') continue;
        commands.add(parseRustHandlerEntry(entry));
    }
    return commands;
}

/**
 * @param {string} [projectRoot]
 * @returns {Set<string>} plugin names from `tauri-plugin-<name>` dependencies
 */
export function readPluginNames(projectRoot = PROJECT_ROOT) {
    const source = fs.readFileSync(path.join(projectRoot, CARGO_TOML_FILE), 'utf8');
    const names = new Set();
    for (const match of source.matchAll(/^\s*tauri-plugin-([a-z0-9-]+)\s*=/gm)) {
        names.add(match[1]);
    }
    return names;
}

/** @param {string} [whitelistFile] */
export function readPluginCommandWhitelist(whitelistFile = PLUGIN_WHITELIST_FILE) {
    if (!fs.existsSync(whitelistFile)) return {};
    return JSON.parse(fs.readFileSync(whitelistFile, 'utf8'));
}

function pluginNameOf(command) {
    if (!command.startsWith('plugin:')) return null;
    return command.slice('plugin:'.length).split('|')[0];
}

function importsNativeServiceBridge(sourceFile, specifier, bridgeFile) {
    if (!specifier.startsWith('.')) return false;
    const resolved = path.resolve(path.dirname(sourceFile), specifier);
    return resolved === bridgeFile || `${resolved}.ts` === bridgeFile;
}

/**
 * @param {string} [projectRoot]
 * @returns {{ invokes: { command: string, file: string, line: number }[], dynamic: { file: string, line: number }[] }}
 */
export function collectNativeServiceInvokes(projectRoot = PROJECT_ROOT) {
    const dir = path.join(projectRoot, NATIVE_SERVICE_DIR);
    const bridgeFile = path.join(dir, 'invoke.ts');
    const invokes = [];
    const dynamic = [];

    for (const file of listTsFiles(dir)) {
        const relativeFile = `${NATIVE_SERVICE_DIR}/${path.relative(dir, file).split(path.sep).join('/')}`;
        const parsed = tseslint.parser.parseForESLint(fs.readFileSync(file, 'utf8'), {
            filePath: file,
            ecmaVersion: 2022,
            sourceType: 'module',
        });

        const invokeLocals = new Set();
        const namespaces = new Set();
        walk(parsed.ast, parsed.visitorKeys ?? {}, (node) => {
            if (node.type !== 'ImportDeclaration') return;
            if (typeof node.source?.value !== 'string') return;
            const isTauriImport = node.source.value.startsWith(TAURI_API_PREFIX);
            const isBridgeImport = importsNativeServiceBridge(file, node.source.value, bridgeFile);
            if (!isTauriImport && !isBridgeImport) return;
            for (const specifier of node.specifiers ?? []) {
                if (isTauriImport && specifier.type === 'ImportNamespaceSpecifier') {
                    namespaces.add(specifier.local.name);
                } else if (
                    specifier.type === 'ImportSpecifier' &&
                    (specifier.imported?.name ?? specifier.imported?.value) === 'invoke'
                ) {
                    invokeLocals.add(specifier.local.name);
                }
            }
        });
        if (invokeLocals.size === 0 && namespaces.size === 0) continue;

        walk(parsed.ast, parsed.visitorKeys ?? {}, (node) => {
            if (node.type !== 'CallExpression') return;
            const callee = node.callee;
            const isInvokeCall =
                (callee?.type === 'Identifier' && invokeLocals.has(callee.name)) ||
                (callee?.type === 'MemberExpression' &&
                    callee.object?.type === 'Identifier' &&
                    namespaces.has(callee.object.name) &&
                    callee.property?.name === 'invoke');
            if (!isInvokeCall) return;

            const argument = node.arguments?.[0];
            if (argument?.type === 'Literal' && typeof argument.value === 'string') {
                invokes.push({
                    command: argument.value,
                    file: relativeFile,
                    line: argument.loc?.start?.line ?? 0,
                });
            } else if (file !== bridgeFile) {
                // `invoke.ts` is the single forwarding bridge that adds traceparent to
                // application commands. Every caller of that bridge is still checked above.
                dynamic.push({ file: relativeFile, line: node.loc?.start?.line ?? 0 });
            }
        });
    }

    invokes.sort(
        (a, b) =>
            a.command.localeCompare(b.command) || a.file.localeCompare(b.file) || a.line - b.line
    );
    return { invokes, dynamic: dynamic.sort((a, b) => a.file.localeCompare(b.file)) };
}

/**
 * Validate the exact plugin-command allow-list. Every entry must name a real
 * plugin command (never a whole plugin), carry a reason, and point at the
 * `NativeService` source file that actually invokes that exact command. A
 * blanket plugin pass or an undocumented/uncallable entry is rejected, so the
 * allow-list stays "exact command + source + reason" instead of a bypass.
 *
 * @param {string} projectRoot
 * @param {Record<string, { source?: unknown, reason?: unknown }>} whitelist
 * @param {Set<string>} pluginNames
 * @param {{ command: string, file: string, line: number }[]} [nativeInvokes]
 * @returns {string[]}
 */
export function validatePluginCommandWhitelist(
    projectRoot,
    whitelist,
    pluginNames,
    nativeInvokes = collectNativeServiceInvokes(projectRoot).invokes
) {
    const errors = [];
    for (const [command, entry] of Object.entries(whitelist)) {
        const plugin = pluginNameOf(command);
        if (plugin === null) {
            errors.push(`${command} is not a plugin command`);
        } else if (!pluginNames.has(plugin)) {
            errors.push(`${command} references unregistered plugin '${plugin}'`);
        }

        if (!entry || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
            errors.push(`${command} has no reason`);
        }

        if (!entry || typeof entry.source !== 'string' || entry.source.trim() === '') {
            errors.push(`${command} has no source`);
            continue;
        }

        const sourceFile = path.join(projectRoot, entry.source);
        if (!fs.existsSync(sourceFile)) {
            errors.push(`${command} source '${entry.source}' does not exist`);
            continue;
        }
        const normalizedSource = entry.source.replaceAll('\\', '/').replace(/^\.\//u, '');
        if (
            !nativeInvokes.some(
                (invoke) => invoke.file === normalizedSource && invoke.command === command
            )
        ) {
            errors.push(`${command} source '${entry.source}' does not invoke ${command}`);
        }
    }
    return errors;
}

/**
 * @param {{ projectRoot?: string, whitelistFile?: string }} [options]
 */
export function checkIpcCommands({ projectRoot = PROJECT_ROOT, whitelistFile } = {}) {
    const rustCommands = readRustCommands(projectRoot);
    const pluginNames = readPluginNames(projectRoot);
    const whitelist = readPluginCommandWhitelist(whitelistFile);
    const { invokes, dynamic } = collectNativeServiceInvokes(projectRoot);

    const whitelistErrors = validatePluginCommandWhitelist(
        projectRoot,
        whitelist,
        pluginNames,
        invokes
    );

    const unknown = [];
    for (const invoke of invokes) {
        const plugin = pluginNameOf(invoke.command);
        const allowed =
            plugin === null ? rustCommands.has(invoke.command) : invoke.command in whitelist;
        if (!allowed) {
            unknown.push({
                command: invoke.command,
                file: invoke.file,
                line: invoke.line,
                reason:
                    plugin === null
                        ? 'no Rust handler'
                        : 'not in the exact plugin command whitelist',
            });
        }
    }
    for (const entry of dynamic) {
        unknown.push({
            command: '<dynamic>',
            file: entry.file,
            line: entry.line,
            reason: 'invoke() argument is not a static string literal',
        });
    }

    return {
        invokes,
        dynamic,
        rustCommandCount: rustCommands.size,
        pluginNames: [...pluginNames].sort(),
        pluginCommands: Object.keys(whitelist).sort(),
        whitelistErrors,
        unknown,
    };
}

const isMain =
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    const result = checkIpcCommands();
    for (const entry of result.unknown) {
        process.stdout.write(
            `${entry.file}:${entry.line} invoke("${entry.command}") ${entry.reason}\n`
        );
    }
    for (const error of result.whitelistErrors)
        process.stdout.write(`plugin whitelist: ${error}\n`);
    process.stdout.write(
        `IPC commands: ${result.invokes.length} NativeService invoke(s) vs ${result.rustCommandCount} Rust handler(s)` +
            ` and ${result.pluginCommands.length} explicit plugin command(s); ${result.unknown.length} unresolved.\n`
    );
    if (result.unknown.length > 0 || result.whitelistErrors.length > 0) process.exitCode = 1;
}
