// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import fs from 'node:fs';
import path from 'node:path';

import * as tseslint from 'typescript-eslint';
import * as vueParser from 'vue-eslint-parser';

import { createModuleResolver } from './module-resolver.mjs';

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
export const DECLARATION_EXTENSIONS = ['.d.ts', '.d.mts', '.d.cts'];

export function isArchitectureSourceFile(filename) {
    const normalized = filename.split(path.sep).join('/');
    return SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

function isStringLiteral(node) {
    return (
        node !== undefined &&
        node !== null &&
        node.type === 'Literal' &&
        typeof node.value === 'string'
    );
}

function literalStringValue(node) {
    if (isStringLiteral(node)) return node.value;
    if (node?.type === 'TemplateLiteral' && (node.expressions?.length ?? 0) === 0) {
        const quasi = node.quasis?.[0];
        return typeof quasi?.value?.cooked === 'string' ? quasi.value.cooked : null;
    }
    return null;
}

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

function importedName(specifier) {
    const imported = specifier.imported ?? specifier.local;
    return imported?.name ?? imported?.value ?? null;
}

export function importMetaGlobForm(node) {
    if (node?.callee?.type !== 'MemberExpression' || node.callee.computed) return null;
    const object = node.callee.object;
    const property = node.callee.property;
    if (
        object?.type !== 'MetaProperty' ||
        object.meta?.name !== 'import' ||
        object.property?.name !== 'meta' ||
        property?.type !== 'Identifier'
    ) {
        return null;
    }
    return property.name === 'glob' || property.name === 'globEager' ? property.name : null;
}

export function literalGlobPatterns(node) {
    const literal = literalStringValue(node);
    if (literal !== null) return [literal];
    if (node?.type !== 'ArrayExpression') return null;

    const patterns = [];
    for (const element of node.elements ?? []) {
        if (element === null || element.type === 'SpreadElement') return null;
        const value = literalStringValue(element);
        if (value === null) return null;
        patterns.push(value);
    }
    return patterns.length === 0 ? null : patterns;
}

function bindingNames(node) {
    switch (node.type) {
        case 'ImportDeclaration': {
            const specifiers = node.specifiers ?? [];
            if (specifiers.length === 0) return ['*'];
            return specifiers.flatMap((specifier) => {
                if (node.importKind !== 'type' && specifier.importKind === 'type') return [];
                if (specifier.type === 'ImportDefaultSpecifier') return ['default'];
                if (specifier.type === 'ImportNamespaceSpecifier') return ['*'];
                const name = importedName(specifier);
                return name === null ? [] : [name];
            });
        }
        case 'ExportNamedDeclaration':
            return (node.specifiers ?? []).flatMap((specifier) => {
                if (node.exportKind !== 'type' && specifier.exportKind === 'type') return [];
                const name = importedName(specifier);
                return name === null ? [] : [name];
            });
        case 'ExportAllDeclaration':
        case 'TSImportEqualsDeclaration':
        case 'TSImportType':
            return ['*'];
        default:
            return ['*'];
    }
}

export function importDeclarationKind(node) {
    if (node.importKind === 'type') return 'type';
    const specifiers = node.specifiers ?? [];
    if (specifiers.length === 0) return 'value';
    return hasRuntimeBinding(specifiers) ? 'value' : 'type';
}

export function exportDeclarationKind(node) {
    if (node.exportKind === 'type') return 'type';
    const specifiers = node.specifiers ?? [];
    if (specifiers.length === 0) return 'value';
    return hasRuntimeBinding(specifiers) ? 'value' : 'type';
}

export function importTypeSpecifier(node) {
    if (isStringLiteral(node.source)) return node.source.value;
    const argument = node.argument;
    if (isStringLiteral(argument)) return argument.value;
    if (argument !== undefined && argument !== null && isStringLiteral(argument.literal)) {
        return argument.literal.value;
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

function vueTemplateExpressions(node, expressions = []) {
    if (node === null || typeof node !== 'object') return expressions;
    if (node.type === 'VExpressionContainer' && node.expression) {
        if (Array.isArray(node.expression.body)) expressions.push(...node.expression.body);
        else expressions.push(node.expression);
    }
    for (const child of node.children ?? []) vueTemplateExpressions(child, expressions);
    for (const attribute of node.startTag?.attributes ?? []) {
        vueTemplateExpressions(attribute.value, expressions);
    }
    return expressions;
}

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

    const edges = [];
    const globs = [];
    const unresolved = [];
    const collectNode = (node) => {
        switch (node.type) {
            case 'ImportDeclaration':
                if (typeof node.source?.value === 'string') {
                    edges.push({
                        specifier: node.source.value,
                        kind: importDeclarationKind(node),
                        bindings: bindingNames(node),
                        line: node.loc?.start?.line ?? 0,
                    });
                }
                break;
            case 'ExportNamedDeclaration':
            case 'ExportAllDeclaration':
                if (typeof node.source?.value === 'string') {
                    edges.push({
                        specifier: node.source.value,
                        kind: exportDeclarationKind(node),
                        bindings: bindingNames(node),
                        line: node.loc?.start?.line ?? 0,
                    });
                }
                break;
            case 'ImportExpression': {
                const specifier = literalStringValue(node.source);
                if (specifier === null) unresolved.push({ line: node.loc?.start?.line ?? 0 });
                else
                    edges.push({
                        specifier,
                        kind: 'dynamic',
                        bindings: ['*'],
                        line: node.loc?.start?.line ?? 0,
                    });
                break;
            }
            case 'CallExpression': {
                const globForm = importMetaGlobForm(node);
                if (globForm !== null) {
                    const patterns = literalGlobPatterns(node.arguments?.[0]);
                    if (patterns === null) {
                        unresolved.push({ line: node.loc?.start?.line ?? 0 });
                    } else {
                        globs.push({
                            patterns,
                            form: globForm,
                            line: node.loc?.start?.line ?? 0,
                        });
                    }
                    break;
                }
                const callee = node.callee;
                if (callee?.type !== 'Identifier' || callee.name !== 'require') break;
                const specifier = literalStringValue(node.arguments?.[0]);
                if (specifier === null) unresolved.push({ line: node.loc?.start?.line ?? 0 });
                else
                    edges.push({
                        specifier,
                        kind: 'dynamic',
                        bindings: ['*'],
                        line: node.loc?.start?.line ?? 0,
                    });
                break;
            }
            case 'TSImportType': {
                const specifier = importTypeSpecifier(node);
                if (specifier !== null)
                    edges.push({
                        specifier,
                        kind: 'type',
                        bindings: ['*'],
                        line: node.loc?.start?.line ?? 0,
                    });
                break;
            }
            case 'TSImportEqualsDeclaration':
                if (
                    node.moduleReference?.type === 'TSExternalModuleReference' &&
                    typeof node.moduleReference.expression?.value === 'string'
                ) {
                    edges.push({
                        specifier: node.moduleReference.expression.value,
                        kind: node.importKind === 'type' ? 'type' : 'value',
                        bindings: ['*'],
                        line: node.loc?.start?.line ?? 0,
                    });
                }
                break;
            default:
                break;
        }
    };
    walk(parsed.ast, parsed.visitorKeys ?? {}, collectNode);
    if (isVue) {
        for (const expression of vueTemplateExpressions(parsed.ast.templateBody)) {
            walk(expression, parsed.visitorKeys ?? {}, collectNode);
        }
    }

    return { edges, globs, unresolved };
}

export function collectImports(code, filename) {
    return collectImportGraph(code, filename).edges;
}

export function validateSourceRoot(srcRoot) {
    let stat;
    try {
        stat = fs.statSync(srcRoot);
        fs.accessSync(srcRoot, fs.constants.R_OK);
    } catch {
        throw new Error(`[invalid-source-root] ${srcRoot} is not a readable directory`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`[invalid-source-root] ${srcRoot} is not a directory`);
    }
}

export function listSourceFiles(root) {
    validateSourceRoot(root);
    const files = [];
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (error) {
            throw new Error(`[unreadable-source-directory] ${current}: ${error.message}`, {
                cause: error,
            });
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                stack.push(full);
            } else if (isArchitectureSourceFile(entry.name)) {
                files.push(full);
            }
        }
    }
    return files.sort();
}

export function describeSource(absolute, { projectRoot, srcRoot }) {
    const normalized = path.resolve(absolute);
    const isVue = normalized.endsWith('.vue');
    const repoRel = path.relative(projectRoot, normalized).split(path.sep).join('/');
    const srcRel = path.relative(srcRoot, normalized).split(path.sep).join('/');
    if (srcRel.startsWith('../') || path.isAbsolute(srcRel)) {
        return { absolute: normalized, repoRel, srcRel: null, isVue };
    }
    return { absolute: normalized, repoRel, srcRel, isVue };
}

export function buildModuleGraph({ projectRoot, srcRoot }) {
    const resolver = createModuleResolver(projectRoot, { srcRoot });
    const files = listSourceFiles(srcRoot);
    if (files.length === 0) {
        throw new Error(`[empty-source-root] ${srcRoot} contains no architecture source files`);
    }
    const described = new Map();
    for (const file of files) {
        const info = describeSource(file, { projectRoot, srcRoot });
        if (info.srcRel === null) continue;
        const existing = described.get(info.srcRel);
        if (existing !== undefined) {
            throw new Error(
                `[source-node-collision] ${info.srcRel} maps to both ${existing.absolute} and ${info.absolute}`
            );
        }
        described.set(info.srcRel, info);
    }

    const nodes = new Map();
    for (const [srcRel, info] of described) {
        nodes.set(srcRel, {
            id: srcRel,
            srcRel,
            absolute: info.absolute,
            isVue: info.isVue,
            external: false,
            virtual: false,
        });
    }

    const adjacency = new Map();
    for (const id of nodes.keys()) adjacency.set(id, []);
    const parseErrors = [];
    const sourceErrors = [];
    const unresolvedLocal = [];
    const unresolvedDynamic = [];

    for (const [srcRel, info] of described) {
        let code;
        try {
            code = fs.readFileSync(info.absolute, 'utf8');
        } catch (error) {
            sourceErrors.push({ importer: srcRel, message: error.message });
            continue;
        }

        let graph;
        try {
            graph = collectImportGraph(code, info.absolute);
        } catch (error) {
            parseErrors.push({ file: srcRel, message: error.message });
            continue;
        }
        for (const unresolved of graph.unresolved) {
            unresolvedDynamic.push({ importer: srcRel, line: unresolved.line });
        }

        for (const edge of graph.edges) {
            const resolution = resolver.resolve(edge.specifier, info.absolute);
            if (resolution.classification === 'unresolved-local') {
                unresolvedLocal.push({
                    importer: srcRel,
                    specifier: edge.specifier,
                    line: edge.line,
                });
                continue;
            }
            if (resolution.classification === 'asset') continue;

            let targetId;
            if (resolution.classification === 'external') {
                targetId = `package:${resolution.package ?? edge.specifier}`;
                if (!nodes.has(targetId)) {
                    nodes.set(targetId, {
                        id: targetId,
                        srcRel: null,
                        absolute: null,
                        external: true,
                        virtual: resolution.virtual,
                        package: resolution.package ?? edge.specifier,
                        packageName: resolution.packageName,
                    });
                }
            } else {
                const target = describeSource(resolution.absolute, { projectRoot, srcRoot });
                if (target.srcRel === null) {
                    unresolvedLocal.push({
                        importer: srcRel,
                        specifier: edge.specifier,
                        line: edge.line,
                    });
                    continue;
                }
                targetId = target.srcRel;
                if (!nodes.has(targetId)) {
                    nodes.set(targetId, {
                        id: targetId,
                        srcRel: target.srcRel,
                        absolute: resolution.absolute,
                        isVue: target.isVue,
                        external: false,
                        virtual: resolution.virtual,
                    });
                }
            }
            adjacency.get(srcRel).push({
                from: srcRel,
                to: targetId,
                specifier: edge.specifier,
                kind: edge.kind,
                bindings: edge.bindings,
                line: edge.line,
            });
            if (!adjacency.has(targetId)) adjacency.set(targetId, []);
        }

        for (const glob of graph.globs) {
            for (const pattern of glob.patterns) {
                let matches;
                try {
                    matches = resolver.expandGlob(pattern, info.absolute);
                } catch (error) {
                    throw new Error(
                        `[architecture-glob] ${srcRel}:${glob.line} ${pattern}: ${error.message}`,
                        { cause: error }
                    );
                }
                for (const match of matches) {
                    if (!isArchitectureSourceFile(match)) continue;
                    const target = describeSource(match, { projectRoot, srcRoot });
                    if (target.srcRel === null) {
                        throw new Error(
                            `[architecture-glob] ${srcRel}:${glob.line} ${pattern} matched ${match}, outside the source root`
                        );
                    }
                    if (!nodes.has(target.srcRel)) {
                        nodes.set(target.srcRel, {
                            id: target.srcRel,
                            srcRel: target.srcRel,
                            absolute: match,
                            isVue: target.isVue,
                            external: false,
                            virtual: false,
                        });
                    }
                    adjacency.get(srcRel).push({
                        from: srcRel,
                        to: target.srcRel,
                        specifier: pattern,
                        kind: 'dynamic',
                        bindings: ['*'],
                        line: glob.line,
                    });
                    if (!adjacency.has(target.srcRel)) adjacency.set(target.srcRel, []);
                }
            }
        }
    }

    return {
        resolver,
        files,
        nodes,
        adjacency,
        parseErrors,
        sourceErrors,
        unresolvedLocal,
        unresolvedDynamic,
    };
}
