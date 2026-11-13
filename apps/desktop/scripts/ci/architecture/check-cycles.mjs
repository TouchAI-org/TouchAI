// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Runtime import-cycle gate.
 *
 * Builds the module graph from the real TypeScript/Vue ASTs (typescript-eslint +
 * vue-eslint-parser, not a text scan), classifies every edge as runtime
 * (`value`/`dynamic`) or `type`, and only reports strongly connected components
 * that contain at least one runtime edge. A cycle made purely of `import type`
 * edges is erased at build time and is reported separately as informational.
 *
 * Existing runtime cycles that predate the RFC are listed in
 * `cycle-baseline.json`; the gate fails only on a NEW runtime cycle. Baselines
 * must not be used to excuse a cycle an in-flight RFC change is already
 * removing.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as tseslint from 'typescript-eslint';
import * as vueParser from 'vue-eslint-parser';

import {
    describeTarget,
    exportDeclarationKind,
    importDeclarationKind,
    importTypeSpecifier,
    isArchitectureSourceFile,
    PROJECT_ROOT,
    resolveToAbsolute,
    SRC_ROOT,
} from './boundaries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CYCLE_BASELINE_PATH = path.join(HERE, 'cycle-baseline.json');

/** @typedef {{ specifier: string, kind: 'value' | 'type' | 'dynamic' }} ImportEdge */

function isStringLiteral(node) {
    return (
        node !== undefined &&
        node !== null &&
        node.type === 'Literal' &&
        typeof node.value === 'string'
    );
}

/** Constrained areas whose dynamic imports must still be statically provable. */
const CONSTRAINED_AREAS = ['services/', 'database/', 'domain/'];

function isConstrained(srcRel) {
    return CONSTRAINED_AREAS.some((prefix) => srcRel.startsWith(prefix));
}

/** @param {any} node @returns {string | null} */
function literalStringValue(node) {
    if (isStringLiteral(node)) return node.value;
    if (node?.type === 'TemplateLiteral' && (node.expressions?.length ?? 0) === 0) {
        const quasi = node.quasis?.[0];
        return typeof quasi?.value?.cooked === 'string' ? quasi.value.cooked : null;
    }
    return null;
}

function walk(node, visitorKeys, visit) {
    if (node === null || typeof node !== 'object' || typeof node.type !== 'string') return;
    visit(node);
    const keys = visitorKeys[node.type] ?? [];
    for (const key of keys) {
        const child = node[key];
        if (Array.isArray(child)) {
            for (const item of child) walk(item, visitorKeys, visit);
        } else if (child !== null && typeof child === 'object') {
            walk(child, visitorKeys, visit);
        }
    }
}

/**
 * Parse `code` with the parser that matches the file type and return every
 * static, dynamic and type-only import as an edge, plus the dynamic imports whose
 * specifier is not statically resolvable.
 *
 * @param {string} code
 * @param {string} filename
 * @returns {{ edges: ImportEdge[], unresolved: { line: number }[] }}
 */
export function collectImportGraph(code, filename) {
    const isVue = filename.endsWith('.vue');
    const parsed = isVue
        ? vueParser.parseForESLint(code, {
              filePath: filename,
              parser: tseslint.parser,
              ecmaVersion: 2022,
              sourceType: 'module',
          })
        : tseslint.parser.parseForESLint(code, {
              filePath: filename,
              ecmaVersion: 2022,
              sourceType: 'module',
          });

    /** @type {ImportEdge[]} */
    const edges = [];
    /** @type {{ line: number }[]} */
    const unresolved = [];
    walk(parsed.ast, parsed.visitorKeys ?? {}, (node) => {
        switch (node.type) {
            case 'ImportDeclaration':
                if (typeof node.source?.value === 'string') {
                    edges.push({ specifier: node.source.value, kind: importDeclarationKind(node) });
                }
                break;
            case 'ExportNamedDeclaration':
            case 'ExportAllDeclaration':
                if (typeof node.source?.value === 'string') {
                    edges.push({
                        specifier: node.source.value,
                        kind: exportDeclarationKind(node),
                    });
                }
                break;
            case 'ImportExpression': {
                const specifier = literalStringValue(node.source);
                if (specifier === null) unresolved.push({ line: node.loc?.start?.line ?? 0 });
                else edges.push({ specifier, kind: 'dynamic' });
                break;
            }
            case 'CallExpression': {
                const callee = node.callee;
                if (callee?.type !== 'Identifier' || callee.name !== 'require') break;
                const specifier = literalStringValue(node.arguments?.[0]);
                if (specifier === null) unresolved.push({ line: node.loc?.start?.line ?? 0 });
                else edges.push({ specifier, kind: 'dynamic' });
                break;
            }
            case 'TSImportType': {
                const specifier = importTypeSpecifier(node);
                if (specifier !== null) edges.push({ specifier, kind: 'type' });
                break;
            }
            case 'TSImportEqualsDeclaration':
                if (
                    node.moduleReference?.type === 'TSExternalModuleReference' &&
                    typeof node.moduleReference.expression?.value === 'string'
                ) {
                    edges.push({
                        specifier: node.moduleReference.expression.value,
                        kind: node.isTypeOnly === true ? 'type' : 'value',
                    });
                }
                break;
            default:
                break;
        }
    });

    return { edges, unresolved };
}

/**
 * Backward-compatible edge-only view of {@link collectImportGraph}.
 *
 * @param {string} code
 * @param {string} filename
 * @returns {ImportEdge[]}
 */
export function collectImports(code, filename) {
    return collectImportGraph(code, filename).edges;
}

/**
 * @param {string} root
 * @returns {string[]} absolute source-file paths covered by the architecture graph
 */
export function listSourceFiles(root) {
    const files = [];
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'drizzle') continue;
                stack.push(full);
            } else if (isArchitectureSourceFile(entry.name)) {
                files.push(full);
            }
        }
    }
    return files.sort();
}

function buildGraph({ projectRoot, srcRoot }) {
    const files = listSourceFiles(srcRoot);
    const roots = { projectRoot, srcRoot };
    const idOf = new Map();
    for (const file of files) {
        const described = describeTarget(file, roots);
        if (described.srcRel !== null) idOf.set(described.srcRel, file);
    }

    /** @type {Map<string, { runtime: Set<string>, type: Set<string> }>} */
    const adjacency = new Map();
    for (const srcRel of idOf.keys())
        adjacency.set(srcRel, { runtime: new Set(), type: new Set() });

    /** @type {{ file: string, message: string }[]} */
    const parseErrors = [];
    /** @type {{ file: string, line: number }[]} */
    const unresolvedDynamic = [];

    for (const [srcRel, file] of idOf) {
        let graph;
        try {
            graph = collectImportGraph(fs.readFileSync(file, 'utf8'), file);
        } catch (error) {
            parseErrors.push({ file: srcRel, message: error.message });
            continue;
        }
        if (isConstrained(srcRel)) {
            for (const gap of graph.unresolved) {
                unresolvedDynamic.push({ file: srcRel, line: gap.line });
            }
        }
        for (const edge of graph.edges) {
            const candidate = resolveToAbsolute(edge.specifier, file);
            if (candidate === null) continue;
            const target = describeTarget(candidate, roots);
            if (target.srcRel === null || !adjacency.has(target.srcRel)) continue;
            const bucket = edge.kind === 'type' ? 'type' : 'runtime';
            adjacency.get(srcRel)[bucket].add(target.srcRel);
        }
    }

    return { adjacency, fileCount: idOf.size, parseErrors, unresolvedDynamic };
}

/** Tarjan's strongly connected components over a single adjacency bucket. */
function stronglyConnectedComponents(adjacency, bucket) {
    let index = 0;
    const indexes = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    /** @type {string[][]} */
    const components = [];

    const visit = (node) => {
        indexes.set(node, index);
        low.set(node, index);
        index += 1;
        stack.push(node);
        onStack.add(node);

        for (const next of adjacency.get(node)[bucket]) {
            if (!indexes.has(next)) {
                visit(next);
                low.set(node, Math.min(low.get(node), low.get(next)));
            } else if (onStack.has(next)) {
                low.set(node, Math.min(low.get(node), indexes.get(next)));
            }
        }

        if (low.get(node) === indexes.get(node)) {
            const component = [];
            let member;
            do {
                member = stack.pop();
                onStack.delete(member);
                component.push(member);
            } while (member !== node);
            components.push(component.sort());
        }
    };

    for (const node of adjacency.keys()) {
        if (!indexes.has(node)) visit(node);
    }
    return components;
}

function selfLoops(adjacency, bucket) {
    const loops = [];
    for (const [node, edges] of adjacency) {
        if (edges[bucket].has(node)) loops.push([node]);
    }
    return loops;
}

function loadCycleBaseline() {
    try {
        const parsed = JSON.parse(fs.readFileSync(CYCLE_BASELINE_PATH, 'utf8'));
        if (!Array.isArray(parsed)) return [];
        return parsed.map((entry) => [...entry.cycle].sort());
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function sameCycle(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * @param {{ projectRoot?: string, srcRoot?: string }} [options]
 */
export function analyzeCycles(options = {}) {
    const projectRoot = options.projectRoot ?? PROJECT_ROOT;
    const srcRoot = options.srcRoot ?? SRC_ROOT;
    const { adjacency, fileCount, parseErrors, unresolvedDynamic } = buildGraph({
        projectRoot,
        srcRoot,
    });
    const baseline = loadCycleBaseline();

    const runtimeComponents = [
        ...stronglyConnectedComponents(adjacency, 'runtime').filter(
            (component) => component.length > 1
        ),
        ...selfLoops(adjacency, 'runtime'),
    ]
        .map((component) => [...component].sort())
        .sort((a, b) => a.join('|').localeCompare(b.join('|')));

    const newRuntimeCycles = runtimeComponents.filter(
        (component) => !baseline.some((entry) => sameCycle(entry, component))
    );

    const typeOnlyComponents = stronglyConnectedComponents(adjacency, 'type')
        .filter((component) => component.length > 1)
        .map((component) => [...component].sort())
        .sort((a, b) => a.join('|').localeCompare(b.join('|')));

    return {
        fileCount,
        parseErrors,
        unresolvedDynamic,
        runtimeCycles: runtimeComponents,
        newRuntimeCycles,
        baselinedCount: runtimeComponents.length - newRuntimeCycles.length,
        typeOnlyCycles: typeOnlyComponents,
    };
}

export function formatReport(result) {
    const lines = [];
    lines.push(`Architecture cycles: ${result.fileCount} source files analyzed.`);
    if (result.parseErrors.length > 0) {
        lines.push(
            `  ${result.parseErrors.length} file(s) failed to parse (the gate fails on these):`
        );
        for (const item of result.parseErrors) lines.push(`    - ${item.file}: ${item.message}`);
    }
    if (result.unresolvedDynamic.length > 0) {
        lines.push(
            `  ${result.unresolvedDynamic.length} non-literal dynamic import(s) in constrained areas:`
        );
        for (const item of result.unresolvedDynamic)
            lines.push(`    - ${item.file}:${item.line} cannot be statically resolved`);
    }
    if (result.typeOnlyCycles.length > 0) {
        lines.push(
            `  ${result.typeOnlyCycles.length} type-only cycle(s) (erased at build, allowed):`
        );
        for (const cycle of result.typeOnlyCycles) lines.push(`    - ${cycle.join(' -> ')}`);
    }
    if (result.runtimeCycles.length === 0) {
        lines.push('  No runtime cycles.');
    } else {
        lines.push(
            `  ${result.runtimeCycles.length} runtime cycle(s), ${result.newRuntimeCycles.length} new:`
        );
        for (const cycle of result.runtimeCycles) {
            const marker = result.newRuntimeCycles.some((item) => sameCycle(item, cycle))
                ? 'NEW '
                : 'baselined ';
            lines.push(`    - ${marker}${cycle.join(' -> ')}`);
        }
    }
    return lines.join('\n');
}

const isMain =
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * Parse `--project-root`/`--src-root` so the CLI can run against guard fixtures.
 *
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
    const options = { projectRoot: PROJECT_ROOT, srcRoot: SRC_ROOT, json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--project-root') options.projectRoot = path.resolve(argv[++index]);
        else if (arg === '--src-root') options.srcRoot = path.resolve(argv[++index]);
        else if (arg === '--json') options.json = true;
    }
    if (options.projectRoot !== PROJECT_ROOT) {
        options.srcRoot = options.srcRoot ?? path.join(options.projectRoot, 'src');
    }
    return options;
}

if (isMain) {
    const options = parseCliArgs(process.argv.slice(2));
    const result = analyzeCycles({ projectRoot: options.projectRoot, srcRoot: options.srcRoot });
    if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
        process.stdout.write(`${formatReport(result)}\n`);
    }
    if (result.parseErrors.length > 0) {
        process.stderr.write(
            `\n${result.parseErrors.length} file(s) could not be parsed; the cycle graph is incomplete. Fix the syntax error (or file an explicit exception), do not treat the gate as green.\n`
        );
        process.exitCode = 1;
    }
    if (result.unresolvedDynamic.length > 0) {
        process.stderr.write(
            `\n${result.unresolvedDynamic.length} non-literal dynamic import(s) in constrained areas cannot be statically resolved; the cycle graph may be incomplete. Make them static (or report a concrete limitation).\n`
        );
        process.exitCode = 1;
    }
    if (result.newRuntimeCycles.length > 0) {
        process.stderr.write(
            `\nFound ${result.newRuntimeCycles.length} new runtime cycle(s). Break the cycle or add a reviewed baseline in cycle-baseline.json.\n`
        );
        process.exitCode = 1;
    }
}
