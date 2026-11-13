// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Focused boundary gate.
 *
 * Runs ESLint with the repository config and reports exactly the architecture
 * signals, so this CLI and `pnpm lint:check` reach the same conclusion:
 *
 *   - `touchai/import-boundaries` (path, dynamic-import and self-barrel rules);
 *   - `@typescript-eslint/no-restricted-imports` (bare-package runtime bans);
 *   - fatal parse errors, which must fail the gate rather than be skipped.
 *
 * Everything else the repo lint config reports is deliberately out of scope for
 * this job.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import * as tseslint from 'typescript-eslint';
import * as vueParser from 'vue-eslint-parser';

import {
    createArchitectureConfig,
    DECLARATION_FILE_GLOBS,
    PROJECT_ROOT,
    readAliasesFromTsconfig,
    SOURCE_FILE_GLOB,
    SOURCE_FILE_PATTERNS,
    SOURCE_FILES,
} from './boundaries.mjs';

export const GATE_RULE_IDS = [
    'touchai/import-boundaries',
    '@typescript-eslint/no-restricted-imports',
];

export const TARGETS = SOURCE_FILES;

/**
 * Parse `--project-root`/`--targets` so the gate can run against a guard
 * fixture as well as the repo root.
 *
 * @param {string[]} argv
 * @returns {{ projectRoot: string, targets: string[] }}
 */
export function parseCliArgs(argv) {
    const options = { projectRoot: PROJECT_ROOT, targets: TARGETS };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--project-root') {
            options.projectRoot = path.resolve(argv[++index]);
            options.targets = [`src/${SOURCE_FILE_GLOB}`];
        } else if (arg === '--targets') {
            options.targets = argv[++index].split(',').map((value) => value.trim());
        }
    }
    return options;
}

/**
 * Configuration for a fixture root. The repo run keeps the real ESLint config
 * (so this CLI and `lint:check` agree); a fixture run builds the same rule and
 * parser stack standalone, pointed at the fixture's own `tsconfig.json`.
 *
 * @param {string} projectRoot
 * @returns {import('eslint').Linter.Config[]}
 */
function fixtureConfig(projectRoot) {
    const srcRoot = path.join(projectRoot, 'src');
    return [
        {
            files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
            ignores: DECLARATION_FILE_GLOBS,
            languageOptions: {
                parser: tseslint.parser,
                ecmaVersion: 2022,
                sourceType: 'module',
                parserOptions: { ecmaFeatures: { jsx: true } },
            },
        },
        {
            files: ['**/*.vue'],
            ignores: DECLARATION_FILE_GLOBS,
            languageOptions: {
                parser: vueParser,
                parserOptions: { parser: tseslint.parser },
                ecmaVersion: 2022,
                sourceType: 'module',
            },
        },
        {
            files: SOURCE_FILE_PATTERNS,
            ignores: DECLARATION_FILE_GLOBS,
            plugins: { '@typescript-eslint': tseslint.plugin },
        },
        ...createArchitectureConfig({
            projectRoot,
            srcRoot,
            aliases: readAliasesFromTsconfig(projectRoot),
            globPrefix: 'src',
        }),
    ];
}

/**
 * @param {{ ruleId?: string | null, fatal?: boolean }} message
 * @returns {boolean}
 */
export function isGateMessage(message) {
    if (message.fatal === true) return true;
    return (
        message.ruleId !== null &&
        message.ruleId !== undefined &&
        GATE_RULE_IDS.includes(message.ruleId)
    );
}

/**
 * @param {{ filePath: string, messages: { ruleId?: string | null, fatal?: boolean, line?: number, column?: number, message: string }[] }[]} results
 */
export function collectGateReport(results) {
    const lines = [];
    const files = new Set();
    let errorCount = 0;

    for (const result of results) {
        const messages = result.messages.filter(isGateMessage);
        if (messages.length === 0) continue;
        files.add(result.filePath);
        for (const message of messages) {
            errorCount += 1;
            const tag = message.fatal === true ? '[parse-error]' : `[${message.ruleId}]`;
            lines.push(
                `${result.filePath}:${message.line ?? 0}:${message.column ?? 0}  ${tag} ${message.message}`
            );
        }
    }

    return { lines, errorCount, fileCount: files.size };
}

async function main() {
    const options = parseCliArgs(process.argv.slice(2));
    const isRepo = options.projectRoot === PROJECT_ROOT;
    const eslint = isRepo
        ? new ESLint({ cwd: PROJECT_ROOT, errorOnUnmatchedPattern: false })
        : new ESLint({
              cwd: options.projectRoot,
              errorOnUnmatchedPattern: false,
              overrideConfigFile: true,
              overrideConfig: fixtureConfig(options.projectRoot),
          });
    const results = await eslint.lintFiles(options.targets);
    const report = collectGateReport(results);

    if (report.lines.length > 0) process.stdout.write(`${report.lines.join('\n')}\n`);
    process.stdout.write(
        `Architecture boundaries: ${results.length} files checked, ${report.errorCount} violation(s) in ${report.fileCount} file(s).\n`
    );

    if (report.errorCount > 0) process.exitCode = 1;
}

const isMain =
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    main().catch((error) => {
        process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
        process.exitCode = 1;
    });
}
