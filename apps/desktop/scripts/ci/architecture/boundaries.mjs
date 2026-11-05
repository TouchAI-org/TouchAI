// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Architecture dependency model and the ESLint rule that enforces it.
 *
 * Enforcement runs inside ESLint (already a dependency) so the gate shares the
 * project's parser stack: typescript-eslint for `.ts` and vue-eslint-parser for
 * `.vue`. The built-in `no-restricted-imports` is used where it is sufficient:
 * the bare-package runtime bans inside `services/**` (see
 * `architecturePackageBanConfig`). It is NOT sufficient for the path-based
 * rules, for three concrete reasons:
 *
 *   1. It matches the raw specifier string. `@/stores/x`, `@services/x` and
 *      `../../stores/x` are three different strings for the same file, so an
 *      alias or a relative path silently bypasses an alias-only pattern.
 *   2. It never visits `import()` expressions. Its visitors are
 *      `ImportDeclaration`, `ExportNamedDeclaration`, `ExportAllDeclaration`
 *      and `TSImportEqualsDeclaration`, so a dynamic import is invisible.
 *   3. It has no per-edge exception, only whole-path / import-name allow lists,
 *      so the RFC-mandated "edge + import kind + reason + exit condition"
 *      baseline cannot be expressed without weakening the whole rule.
 *
 * This rule resolves every specifier to a real path using the TypeScript
 * compiler's own tsconfig/alias data and applies the model uniformly to static,
 * dynamic and type-only imports.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import * as tseslint from 'typescript-eslint';
import * as vueParser from 'vue-eslint-parser';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, derived from this file's location. */
export const PROJECT_ROOT = path.resolve(HERE, '../../../../..');
/** Frontend source root the rules classify against. */
export const SRC_ROOT = path.join(PROJECT_ROOT, 'apps/desktop/src');

const BASELINE_PATH = path.join(HERE, 'baseline-exceptions.json');

export const SOURCE_EXTENSIONS = [
    '.vue',
    '.tsx',
    '.mts',
    '.cts',
    '.ts',
    '.jsx',
    '.mjs',
    '.cjs',
    '.js',
];
export const DECLARATION_FILE_GLOBS = ['**/*.d.ts', '**/*.d.mts', '**/*.d.cts'];
export const SOURCE_FILE_GLOB = '**/*.{vue,tsx,mts,cts,ts,jsx,mjs,cjs,js}';
export const SOURCE_FILE_PATTERNS = [SOURCE_FILE_GLOB];

const KNOWN_EXTENSIONS = SOURCE_EXTENSIONS;
const DECLARATION_EXTENSIONS = ['.d.ts', '.d.mts', '.d.cts'];

/**
 * Directory -> architecture layer. Anything not listed is a leaf/support area
 * (`utils`, `lib`, `types`, `config`, `i18n`, `router`, `prompts`, `styles`)
 * that any layer may import.
 */
const AREA_LAYER = {
    views: 'ui',
    components: 'ui',
    composables: 'ui-state',
    stores: 'ui-state',
    services: 'services',
    database: 'data',
};

/**
 * Host adapters that may keep a runtime dependency the service-core rules
 * forbid, because their whole job is to bridge the host/UI runtime.
 *
 * Empty today: `PopupService`'s Vue renderer registry is moving to
 * `views/PopupView`, and the settings store facade lives under `stores/`, so no
 * service-core file needs a runtime Vue/UI import. Add an entry only with the
 * adapter's owner, a stated reason, and an exit condition; a non-empty entry is
 * a deliberate, reviewable exception, never a blanket directory ignore.
 *
 * @type {{ file: string, reason: string, exit: string, issue: string }[]}
 */
export const HOST_ADAPTERS = [];

/** Bare UI-runtime packages the service core and neutral domain must not depend on. */
export const RUNTIME_UI_PACKAGES = ['vue', 'pinia', 'vue-router', '@vue/*'];

/** Bare Tauri runtime packages a neutral domain module must not depend on. */
export const RUNTIME_HOST_PACKAGES = ['@tauri-apps/*'];

const RULE_GUIDANCE = {
    'services-runtime-ui':
        'Service core must not runtime-import Vue UI (views/components/composables/stores) or a .vue file. Keep the logic pure, expose a neutral contract, or move the host wiring to a store facade/host adapter. Type-only imports are allowed.',
    'contracts-runtime-executor-internals':
        'Public contracts must not depend on executor/runtime internals (execution/**). Keep checkpoints internal and expose only allowlisted DTOs and events.',
    'no-self-barrel':
        'An internal module must not import its own public barrel (index). Import the concrete sibling module instead; self-barrel imports create a runtime cycle.',
    'database-no-service-reverse':
        'The database layer must not depend on business services (only the NativeService host bridge). Keep shared policy in a neutral domain module instead of reaching up into services.',
    'domain-neutral-no-host':
        'A neutral domain module must not depend on the host runtime or on upper layers (Vue/Pinia/Tauri, views/components/composables/stores, services). It stays a pure, dependency-direction-safe policy module. Type-only imports are allowed.',
};

/**
 * Bare-package bans per importing area. Static value imports are enforced by
 * `@typescript-eslint/no-restricted-imports` (see `createArchitectureConfig`);
 * the same list is applied to dynamic imports by the local rule.
 */
export const PACKAGE_BAN_AREAS = [
    {
        name: 'services',
        packages: RUNTIME_UI_PACKAGES,
        message: RULE_GUIDANCE['services-runtime-ui'],
    },
    {
        name: 'domain',
        packages: [...RUNTIME_UI_PACKAGES, ...RUNTIME_HOST_PACKAGES],
        message: RULE_GUIDANCE['domain-neutral-no-host'],
    },
];

/**
 * The path-based rules. Each rule is applied to a resolved edge, so `@/`, alias,
 * and relative specifiers are all seen the same way.
 *
 * @type {{
 *   id: string,
 *   importer: (srcRel: string) => boolean,
 *   forbidden: (target: { srcRel: string, layer: string }, importerSrcRel: string) => boolean,
 *   kinds: ('value' | 'type' | 'dynamic')[],
 * }[]}
 */
export const IMPORT_BOUNDARY_RULES = [
    {
        id: 'services-runtime-ui',
        importer: (srcRel) => srcRel.startsWith('services/'),
        forbidden: (target) => target.isVue || target.layer === 'ui' || target.layer === 'ui-state',
        kinds: ['value', 'dynamic'],
    },
    {
        id: 'contracts-runtime-executor-internals',
        importer: (srcRel) => srcRel.startsWith('services/AgentService/contracts/'),
        forbidden: (target) => target.srcRel.startsWith('services/AgentService/execution/'),
        kinds: ['value', 'type', 'dynamic'],
    },
    {
        id: 'no-self-barrel',
        importer: (srcRel) => srcRel.startsWith('services/') || srcRel.startsWith('stores/'),
        forbidden: (target, importerSrcRel) => {
            if (target.srcRel === importerSrcRel) return false;
            if (!target.srcRel.endsWith('/index')) return false;
            const moduleDir = target.srcRel.slice(0, -'/index'.length);
            return importerSrcRel.startsWith(`${moduleDir}/`);
        },
        kinds: ['value', 'dynamic'],
    },
    {
        id: 'database-no-service-reverse',
        importer: (srcRel) => srcRel.startsWith('database/'),
        forbidden: (target) =>
            isUnder(target.srcRel, 'services') && !isUnder(target.srcRel, 'services/NativeService'),
        kinds: ['value', 'dynamic'],
    },
    {
        id: 'domain-neutral-no-host',
        importer: (srcRel) => srcRel.startsWith('domain/'),
        forbidden: (target) =>
            target.isVue ||
            target.layer === 'ui' ||
            target.layer === 'ui-state' ||
            target.srcRel.startsWith('services/'),
        kinds: ['value', 'dynamic'],
    },
];

function toPosixPath(value) {
    return value.split(path.sep).join('/');
}

/** True when `value` equals `prefix` or is nested under it. */
export function isUnder(value, prefix) {
    return value === prefix || value.startsWith(`${prefix}/`);
}

/**
 * Specifier value of a `TSImportType` (`typeof import('x')`). Prefers the
 * current `source` property; falls back to the deprecated `argument` shapes for
 * older parsers.
 *
 * @param {any} node
 * @returns {string | null}
 */
export function importTypeSpecifier(node) {
    if (isStringLiteral(node.source)) return node.source.value;
    const argument = node.argument;
    if (isStringLiteral(argument)) return argument.value;
    if (argument !== undefined && argument !== null && isStringLiteral(argument.literal)) {
        return argument.literal.value;
    }
    return null;
}

/**
 * Whether a filename is a source file covered by the architecture graph.
 *
 * @param {string} filename
 * @returns {boolean}
 */
export function isArchitectureSourceFile(filename) {
    const normalized = filename.split(path.sep).join('/');
    if (DECLARATION_EXTENSIONS.some((extension) => normalized.endsWith(extension))) {
        return false;
    }
    return SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

/**
 * @param {string} srcRel path relative to the source root, no extension
 * @returns {string} architecture layer for the file
 */
export function layerOf(srcRel) {
    const [area] = srcRel.split('/');
    return AREA_LAYER[area] ?? 'support';
}

function stripExtension(value) {
    for (const extension of KNOWN_EXTENSIONS) {
        if (value.endsWith(extension)) return value.slice(0, -extension.length);
    }
    return value;
}

function isFile(candidate) {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function normalizeTargetPath(candidate) {
    if (isFile(candidate)) return candidate;
    for (const extension of KNOWN_EXTENSIONS) {
        if (isFile(candidate + extension)) return candidate + extension;
    }
    for (const extension of KNOWN_EXTENSIONS) {
        const barrel = path.join(candidate, `index${extension}`);
        if (isFile(barrel)) return barrel;
    }
    return candidate;
}

/**
 * Describe a real file path the same way for importers and targets.
 *
 * @param {string} absolutePath
 * @param {{ projectRoot?: string, srcRoot?: string }} [roots] override for fixtures/tests
 * @returns {{ absolute: string, repoRel: string, srcRel: string | null, isVue: boolean, layer: string }}
 */
export function describeTarget(absolutePath, roots = {}) {
    const projectRoot = roots.projectRoot ?? PROJECT_ROOT;
    const srcRoot = roots.srcRoot ?? SRC_ROOT;
    const normalized = normalizeTargetPath(path.resolve(absolutePath));
    const repoRel = toPosixPath(path.relative(projectRoot, normalized));
    const isVue = normalized.endsWith('.vue');
    const srcPrefix = `${toPosixPath(path.relative(projectRoot, srcRoot))}/`;
    const srcRel = repoRel.startsWith(srcPrefix)
        ? stripExtension(repoRel.slice(srcPrefix.length))
        : null;

    return {
        absolute: normalized,
        repoRel,
        srcRel,
        isVue,
        layer: srcRel === null ? 'external' : layerOf(srcRel),
    };
}

/**
 * Read the `baseUrl`/`paths` alias map from a project's `tsconfig.json`. A full
 * repository root has it under `apps/desktop/`; a guard fixture may keep one at
 * its own root.
 *
 * @param {string} projectRoot
 * @returns {{ baseUrl: string, paths: Record<string, string[]> }}
 */
export function readAliasesFromTsconfig(projectRoot) {
    const candidate = [
        path.join(projectRoot, 'apps/desktop/tsconfig.json'),
        path.join(projectRoot, 'tsconfig.json'),
    ].find((file) => fs.existsSync(file));
    if (candidate === undefined) {
        throw new Error(`No tsconfig.json under ${projectRoot} to read module aliases from`);
    }

    const configFile = ts.readConfigFile(candidate, ts.sys.readFile);
    if (configFile.error !== undefined) {
        throw new Error(`Failed to read ${candidate}`);
    }

    const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(candidate)
    );

    return {
        baseUrl: parsed.options.baseUrl ?? path.dirname(candidate),
        paths: parsed.options.paths ?? {},
    };
}

const ALIASES = readAliasesFromTsconfig(PROJECT_ROOT);

/**
 * Resolve a specifier to an absolute path using the tsconfig `paths` map, or
 * `null` when the specifier is an external package.
 *
 * @param {string} specifier
 * @param {string} importerAbsolute
 * @returns {string | null}
 */
export function resolveToAbsolute(specifier, importerAbsolute, aliases = ALIASES) {
    if (specifier.startsWith('.')) {
        return path.resolve(path.dirname(importerAbsolute), specifier);
    }

    for (const [pattern, targets] of Object.entries(aliases.paths ?? {})) {
        const target = targets[0];
        if (target === undefined) continue;
        const star = pattern.indexOf('*');
        if (star === -1) {
            if (specifier === pattern) return path.resolve(aliases.baseUrl, target);
            continue;
        }
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        const isMatch =
            specifier.startsWith(prefix) &&
            specifier.endsWith(suffix) &&
            specifier.length >= prefix.length + suffix.length;
        if (!isMatch) continue;
        const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
        return path.resolve(aliases.baseUrl, target.replaceAll('*', wildcard));
    }

    return null;
}

/**
 * Import kind of an `ImportDeclaration`: `type` when the whole declaration is
 * erased (explicit `import type`, or only type-only named specifiers), else
 * `value`.
 *
 * @param {any} node
 * @returns {'value' | 'type'}
 */
/**
 * An import/export declaration is `type` only when every binding is erased:
 * `import type`, `export type`, or a declaration whose specifiers are all
 * individually type-marked (`import { type X }`, `export { type X }`). A single
 * runtime specifier makes the whole declaration a runtime edge.
 */
function hasRuntimeBinding(specifiers) {
    return specifiers.some((specifier) => {
        if (
            specifier.type === 'ImportDefaultSpecifier' ||
            specifier.type === 'ImportNamespaceSpecifier'
        ) {
            return true;
        }
        return (specifier.importKind ?? specifier.exportKind) !== 'type';
    });
}

export function importDeclarationKind(node) {
    if (node.importKind === 'type') return 'type';
    const specifiers = node.specifiers ?? [];
    if (specifiers.length === 0) return 'value';
    return hasRuntimeBinding(specifiers) ? 'value' : 'type';
}

/**
 * Kind of an `export ... from` declaration. `export { type X } from './y'` has
 * a parent `exportKind` of `value`, so it is classified from the specifiers.
 */
export function exportDeclarationKind(node) {
    if (node.exportKind === 'type') return 'type';
    const specifiers = node.specifiers ?? [];
    if (specifiers.length === 0) return 'value';
    return hasRuntimeBinding(specifiers) ? 'value' : 'type';
}

function loadBaseline() {
    try {
        const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

const BASELINE = loadBaseline();

function isBaselined(ruleId, importerSrcRel, targetSrcRel, kind) {
    return BASELINE.some(
        (entry) =>
            entry.rule === ruleId &&
            entry.importer === importerSrcRel &&
            entry.target === targetSrcRel &&
            (entry.kind === kind || entry.kind === 'any')
    );
}

function isHostAdapter(importerSrcRel) {
    return HOST_ADAPTERS.some((adapter) => importerSrcRel === stripExtension(adapter.file));
}

function isBannedPackage(specifier, packages) {
    return packages.some((pattern) =>
        pattern.endsWith('/*') ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern
    );
}

function reportMessage(rule, importer, target, kind, specifier) {
    return `${RULE_GUIDANCE[rule.id]} [${rule.id}] ${kind} import "${specifier}" from ${importer.srcRel} -> ${target.srcRel}`;
}

function isStringLiteral(node) {
    return (
        node !== undefined &&
        node !== null &&
        node.type === 'Literal' &&
        typeof node.value === 'string'
    );
}

/**
 * Static string value of an import argument: a plain string literal, or a
 * template literal with no expressions. Anything else is not statically
 * resolvable.
 *
 * @param {any} node
 * @returns {string | null}
 */
function literalStringValue(node) {
    if (isStringLiteral(node)) return node.value;
    if (node?.type === 'TemplateLiteral' && (node.expressions?.length ?? 0) === 0) {
        const quasi = node.quasis?.[0];
        return typeof quasi?.value?.cooked === 'string' ? quasi.value.cooked : null;
    }
    return null;
}

const importBoundariesRule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Enforce TouchAI architecture ownership: service/layer boundaries, internal barrels and public contracts.',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    projectRoot: { type: 'string' },
                    srcRoot: { type: 'string' },
                    aliases: { type: 'object' },
                },
                additionalProperties: false,
            },
        ],
        messages: {
            boundary: '{{message}}',
        },
    },
    create(context) {
        const options = context.options[0] ?? {};
        const roots = { projectRoot: options.projectRoot, srcRoot: options.srcRoot };
        const aliases = options.aliases ?? ALIASES;
        const filename = context.filename ?? context.getFilename();
        const importer = describeTarget(filename, roots);
        if (importer.srcRel === null) return {};
        const importerSrcRel = importer.srcRel;

        // Only constrained areas need the unresolved signal; support areas are
        // not governed by any dynamic-import rule.
        function dynamicRuleForImporter() {
            return IMPORT_BOUNDARY_RULES.find(
                (rule) => rule.importer(importerSrcRel) && rule.kinds.includes('dynamic')
            );
        }

        function reportUnresolved(what, reportNode) {
            if (dynamicRuleForImporter() === undefined) return;
            context.report({
                node: reportNode,
                messageId: 'boundary',
                data: {
                    message:
                        `[unresolved-dynamic-import] a non-literal ${what} in ${importerSrcRel} ` +
                        `cannot be statically resolved; the boundary gate fails instead of silently ` +
                        `skipping it. Use a static specifier, or move the dynamic host wiring out of a ` +
                        `constrained area.`,
                },
            });
        }

        function check(specifier, kind, reportNode) {
            if (typeof specifier !== 'string') return;

            const candidate = resolveToAbsolute(specifier, filename, aliases);
            if (candidate === null) {
                if (kind === 'dynamic') {
                    const area = PACKAGE_BAN_AREAS.find((entry) =>
                        importerSrcRel.startsWith(`${entry.name}/`)
                    );
                    if (area && isBannedPackage(specifier, area.packages)) {
                        context.report({
                            node: reportNode,
                            messageId: 'boundary',
                            data: {
                                message: `${area.message} [${area.name}-dynamic-package] dynamic import "${specifier}" from ${importerSrcRel}`,
                            },
                        });
                    }
                }
                return;
            }

            const target = describeTarget(candidate, roots);
            if (target.srcRel === null) return;

            for (const rule of IMPORT_BOUNDARY_RULES) {
                if (!rule.importer(importerSrcRel)) continue;
                if (!rule.kinds.includes(kind)) continue;
                if (!rule.forbidden(target, importerSrcRel)) continue;
                if (isHostAdapter(importerSrcRel)) continue;
                if (isBaselined(rule.id, importerSrcRel, target.srcRel, kind)) continue;
                context.report({
                    node: reportNode,
                    messageId: 'boundary',
                    data: { message: reportMessage(rule, importer, target, kind, specifier) },
                });
            }
        }

        return {
            ImportDeclaration(node) {
                check(node.source?.value, importDeclarationKind(node), node.source);
            },
            ExportNamedDeclaration(node) {
                if (node.source === null) return;
                check(node.source.value, exportDeclarationKind(node), node.source);
            },
            ExportAllDeclaration(node) {
                check(node.source?.value, exportDeclarationKind(node), node.source);
            },
            TSImportEqualsDeclaration(node) {
                if (node.moduleReference?.type !== 'TSExternalModuleReference') return;
                const expression = node.moduleReference.expression;
                check(expression?.value, node.isTypeOnly === true ? 'type' : 'value', node);
            },
            ImportExpression(node) {
                const specifier = literalStringValue(node.source);
                if (specifier === null) {
                    reportUnresolved('import()', node);
                    return;
                }
                check(specifier, 'dynamic', node.source);
            },
            CallExpression(node) {
                const callee = node.callee;
                if (callee?.type !== 'Identifier' || callee.name !== 'require') return;
                const argument = node.arguments?.[0];
                const specifier = literalStringValue(argument);
                if (specifier === null) {
                    reportUnresolved('require()', node);
                    return;
                }
                check(specifier, 'dynamic', argument);
            },
            TSImportType(node) {
                const value = importTypeSpecifier(node);
                if (value === null) return;
                check(value, 'type', node.source ?? node);
            },
        };
    },
};

export const architecturePlugin = {
    rules: {
        'import-boundaries': importBoundariesRule,
    },
};

export const SOURCE_FILES = [`apps/desktop/src/${SOURCE_FILE_GLOB}`];

/**
 * Flat-config entries for the repo `eslint.config.js`. Parsers are already
 * configured there, so these only add the plugin, the rule and the package ban.
 *
 * `projectRoot`/`srcRoot`/`aliases` are only needed by the guard tests, which
 * point the rule at a fixture tree; the repo config uses the defaults compiled
 * from `tsconfig.json`.
 *
 * @param {{ projectRoot?: string, srcRoot?: string, aliases?: object, files?: string[], globPrefix?: string, serviceFiles?: string[] }} [options]
 */
export function createArchitectureConfig({
    projectRoot,
    srcRoot,
    aliases,
    files = SOURCE_FILE_PATTERNS,
    globPrefix = 'apps/desktop/src',
} = {}) {
    const ruleOptions = {};
    if (projectRoot !== undefined) ruleOptions.projectRoot = projectRoot;
    if (srcRoot !== undefined) ruleOptions.srcRoot = srcRoot;
    if (aliases !== undefined) ruleOptions.aliases = aliases;
    const hasOptions = Object.keys(ruleOptions).length > 0;

    const areaFiles = (area) => [`${globPrefix}/${area}/${SOURCE_FILE_GLOB}`];

    const config = [
        {
            name: 'touchai/architecture-boundaries',
            files,
            ignores: DECLARATION_FILE_GLOBS,
            plugins: { touchai: architecturePlugin },
            rules: {
                'touchai/import-boundaries': hasOptions ? ['error', ruleOptions] : 'error',
            },
        },
    ];

    for (const area of PACKAGE_BAN_AREAS) {
        config.push({
            name: `touchai/architecture-runtime-packages-${area.name}`,
            files: areaFiles(area.name),
            ignores: DECLARATION_FILE_GLOBS,
            rules: {
                'no-restricted-imports': 'off',
                '@typescript-eslint/no-restricted-imports': [
                    'error',
                    {
                        patterns: [
                            {
                                group: area.packages,
                                allowTypeImports: true,
                                message: area.message,
                            },
                        ],
                    },
                ],
            },
        });
    }

    return config;
}

/**
 * The repo configuration: source-scoped file patterns with the compiled
 * tsconfig alias map. `SOURCE_FILES`/`SERVICE_FILES` are kept for clarity.
 */
export const architectureConfig = createArchitectureConfig({ files: SOURCE_FILES });

/**
 * Standalone config for the focused CLI (`check-boundaries.mjs`). It carries its
 * own parser setup because it does not load the repo `eslint.config.js`.
 */
export function createStandaloneConfig(options = {}) {
    return [
        {
            name: 'touchai/architecture-parsers',
            files: SOURCE_FILE_PATTERNS,
            ignores: DECLARATION_FILE_GLOBS,
            languageOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
                parserOptions: { ecmaFeatures: { jsx: true } },
            },
        },
        {
            name: 'touchai/architecture-parser-ts',
            files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
            ignores: DECLARATION_FILE_GLOBS,
            languageOptions: {
                parser: tseslint.parser,
                parserOptions: { ecmaFeatures: { jsx: true } },
            },
        },
        {
            name: 'touchai/architecture-parser-vue',
            files: ['**/*.vue'],
            ignores: DECLARATION_FILE_GLOBS,
            languageOptions: {
                parser: vueParser,
                parserOptions: { parser: tseslint.parser },
            },
        },
        {
            name: 'touchai/architecture-plugin',
            files: SOURCE_FILE_PATTERNS,
            ignores: DECLARATION_FILE_GLOBS,
            plugins: { '@typescript-eslint': tseslint.plugin },
        },
        ...createArchitectureConfig({ ...options, files: SOURCE_FILE_PATTERNS }),
    ];
}
