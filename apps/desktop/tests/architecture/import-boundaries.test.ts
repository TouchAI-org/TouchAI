import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const srcRoot = resolve(__dirname, '../../src');

const ignoredDirectories = new Set(['node_modules', 'target', 'dist', 'build', 'coverage']);
const sourceFileExtensions = new Set(['.ts', '.tsx', '.vue']);

interface ImportEdge {
    fromFile: string;
    fromModule: string;
    specifier: string;
    toModule: string;
}

interface RawImport {
    fromFile: string;
    fromModule: string;
    specifier: string;
}

const importPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const allowedBaselineViolationFragments = [
    'database -> services/NativeService',
    'services/AuthService -> services/AgentService',
    'services/EventService -> services/PopupService',
    'services/PopupService -> views/PopupView',
];

const allowedBaselineCycles = [
    ['database', 'services/NativeService'],
    ['services/AgentService', 'services/AuthService'],
    ['services/AgentService', 'services/BuiltInToolService'],
    ['services/AgentService', 'types'],
    ['services/EventService', 'services/PopupService'],
    ['services/EventService', 'utils'],
    ['services/NativeService', 'utils'],
    ['services/PopupService', 'views/PopupView'],
];

function withoutAllowedBaselineViolations(violations: string[]): string[] {
    return violations.filter(
        (violation) =>
            !allowedBaselineViolationFragments.some((fragment) => violation.includes(fragment))
    );
}

function isAllowedBaselineCycle(cycle: string[]): boolean {
    return allowedBaselineCycles.some(
        (allowedCycle) =>
            allowedCycle.length === cycle.length &&
            allowedCycle.every((moduleName) => cycle.includes(moduleName))
    );
}

function walkFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (ignoredDirectories.has(entry.name)) {
            return [];
        }

        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            return walkFiles(fullPath);
        }

        const extension = entry.name.slice(entry.name.lastIndexOf('.'));
        return sourceFileExtensions.has(extension) ? [fullPath] : [];
    });
}

function moduleNameFor(filePath: string): string {
    const relativePath = relative(srcRoot, filePath).replace(/\\/g, '/');
    const [first = '', second] = relativePath.split('/');

    if (first === 'services' && second) {
        return `services/${second}`;
    }

    if (first === 'views' && second) {
        return `views/${second}`;
    }

    return first;
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
    if (specifier.startsWith('@/')) {
        return join(srcRoot, specifier.slice(2));
    }

    const aliases: Record<string, string> = {
        '@assets': join(srcRoot, 'assets'),
        '@components': join(srcRoot, 'components'),
        '@composables': join(srcRoot, 'composables'),
        '@database': join(srcRoot, 'database'),
        '@services': join(srcRoot, 'services'),
        '@styles': join(srcRoot, 'styles'),
        '@types': join(srcRoot, 'types'),
        '@utils': join(srcRoot, 'utils'),
    };

    for (const [alias, target] of Object.entries(aliases)) {
        if (specifier === alias) {
            return target;
        }

        if (specifier.startsWith(`${alias}/`)) {
            return join(target, specifier.slice(alias.length + 1));
        }
    }

    if (specifier.startsWith('.')) {
        return resolve(dirname(fromFile), specifier);
    }

    return null;
}

function collectRawImports(): RawImport[] {
    return walkFiles(srcRoot).flatMap((fromFile) => {
        const text = readFileSync(fromFile, 'utf8');
        const fromModule = moduleNameFor(fromFile);
        const imports: RawImport[] = [];

        for (const match of text.matchAll(importPattern)) {
            const specifier = match[1] ?? match[2];
            if (!specifier) {
                continue;
            }

            imports.push({
                fromFile: relative(srcRoot, fromFile).replace(/\\/g, '/'),
                fromModule,
                specifier,
            });
        }

        return imports;
    });
}

function collectEdges(): ImportEdge[] {
    return collectRawImports().flatMap((rawImport) => {
        const fromFile = join(srcRoot, rawImport.fromFile);
        const fromModule = rawImport.fromModule;
        const specifier = rawImport.specifier;
        const resolved = resolveSpecifier(fromFile, specifier);
        if (!resolved || !resolved.startsWith(srcRoot)) {
            return [];
        }

        const toModule = moduleNameFor(resolved);
        if (toModule !== fromModule) {
            return [
                {
                    fromFile: rawImport.fromFile,
                    fromModule,
                    specifier,
                    toModule,
                },
            ];
        }

        return [];
    });
}

function findForbiddenEdges(
    edges: ImportEdge[],
    rules: Array<{ from: RegExp; to: RegExp; reason: string }>
): string[] {
    return edges.flatMap((edge) => {
        const rule = rules.find(
            (candidate) => candidate.from.test(edge.fromModule) && candidate.to.test(edge.toModule)
        );

        if (!rule) {
            return [];
        }

        return [
            `${edge.fromFile}: ${edge.fromModule} -> ${edge.toModule} via ${edge.specifier} (${rule.reason})`,
        ];
    });
}

function findForbiddenRawImports(
    imports: RawImport[],
    rules: Array<{ from: RegExp; specifier: RegExp; reason: string }>
): string[] {
    return imports.flatMap((rawImport) => {
        const rule = rules.find(
            (candidate) =>
                candidate.from.test(rawImport.fromModule) &&
                candidate.specifier.test(rawImport.specifier)
        );

        if (!rule) {
            return [];
        }

        return [
            `${rawImport.fromFile}: ${rawImport.fromModule} imports ${rawImport.specifier} (${rule.reason})`,
        ];
    });
}

function findStronglyConnectedComponents(edges: ImportEdge[]): string[][] {
    const modules = new Set<string>();
    const adjacency = new Map<string, Set<string>>();

    for (const edge of edges) {
        modules.add(edge.fromModule);
        modules.add(edge.toModule);
        if (!adjacency.has(edge.fromModule)) {
            adjacency.set(edge.fromModule, new Set());
        }
        adjacency.get(edge.fromModule)?.add(edge.toModule);
    }

    let nextIndex = 0;
    const stack: string[] = [];
    const onStack = new Set<string>();
    const indexes = new Map<string, number>();
    const lowLinks = new Map<string, number>();
    const components: string[][] = [];

    function visit(moduleName: string): void {
        indexes.set(moduleName, nextIndex);
        lowLinks.set(moduleName, nextIndex);
        nextIndex += 1;
        stack.push(moduleName);
        onStack.add(moduleName);

        for (const dependency of adjacency.get(moduleName) ?? []) {
            if (!indexes.has(dependency)) {
                visit(dependency);
                lowLinks.set(
                    moduleName,
                    Math.min(lowLinks.get(moduleName)!, lowLinks.get(dependency)!)
                );
                continue;
            }

            if (onStack.has(dependency)) {
                lowLinks.set(
                    moduleName,
                    Math.min(lowLinks.get(moduleName)!, indexes.get(dependency)!)
                );
            }
        }

        if (lowLinks.get(moduleName) !== indexes.get(moduleName)) {
            return;
        }

        const component: string[] = [];
        let current: string | undefined;
        do {
            current = stack.pop();
            if (!current) {
                break;
            }
            onStack.delete(current);
            component.push(current);
        } while (current !== moduleName);

        if (component.length > 1) {
            components.push(component.sort());
        }
    }

    for (const moduleName of modules) {
        if (!indexes.has(moduleName)) {
            visit(moduleName);
        }
    }

    return components.sort((left, right) => left.join(',').localeCompare(right.join(',')));
}

describe('architecture import boundaries', () => {
    it('keeps implementation modules on approved dependency direction', () => {
        const violations = findForbiddenEdges(collectEdges(), [
            {
                from: /^services\//,
                to: /^views\//,
                reason: 'services must not import Vue view modules',
            },
            {
                from: /^services\/BuiltInToolService$/,
                to: /^services\/AgentService$/,
                reason: 'built-in tools must depend on contracts, not AgentService implementation',
            },
            {
                from: /^services\/AuthService$/,
                to: /^services\/AgentService$/,
                reason: 'auth must depend on provider config policy/contracts, not AgentService infrastructure',
            },
            {
                from: /^services\/EventService$/,
                to: /^services\/PopupService$/,
                reason: 'events must depend on popup contracts, not PopupService implementation',
            },
            {
                from: /^services\/NativeService$/,
                to: /^utils$/,
                reason: 'native bridge types must not depend on UI/session utility helpers',
            },
            {
                from: /^database$/,
                to: /^services\/NativeService$/,
                reason: 'database layer must not call native bridge directly',
            },
        ]);

        expect(withoutAllowedBaselineViolations(violations)).toEqual([]);
    });

    it('keeps stable contracts independent from implementation modules', () => {
        const violations = findForbiddenEdges(collectEdges(), [
            {
                from: /^contracts$/,
                to: /^services\//,
                reason: 'contracts must not depend on implementation services',
            },
            {
                from: /^contracts$/,
                to: /^views\//,
                reason: 'contracts must not depend on UI views',
            },
            {
                from: /^contracts$/,
                to: /^database$/,
                reason: 'contracts must not depend on database implementation or entity modules',
            },
            {
                from: /^contracts$/,
                to: /^utils$/,
                reason: 'contracts must not depend on utility implementation helpers',
            },
            {
                from: /^contracts$/,
                to: /^components$/,
                reason: 'contracts must not depend on UI component modules',
            },
            {
                from: /^contracts$/,
                to: /^composables$/,
                reason: 'contracts must not depend on view/application composables',
            },
        ]);

        expect(violations).toEqual([]);
    });

    it('keeps stable contracts free of UI/runtime framework imports', () => {
        const violations = findForbiddenRawImports(collectRawImports(), [
            {
                from: /^contracts$/,
                specifier: /^vue$/,
                reason: 'contracts must not import Vue',
            },
            {
                from: /^contracts$/,
                specifier: /\.vue$/,
                reason: 'contracts must not import Vue single-file components',
            },
            {
                from: /^contracts$/,
                specifier: /^@tauri-apps\//,
                reason: 'contracts must not import Tauri runtime APIs',
            },
            {
                from: /^contracts$/,
                specifier: /^@\/(?:services|database|utils|views|components|composables|stores)\b/,
                reason: 'contracts must not import implementation-layer aliases',
            },
            {
                from: /^contracts$/,
                specifier: /^@(?:services|database|utils|components|composables)\b/,
                reason: 'contracts must not import implementation-layer aliases',
            },
        ]);

        expect(violations).toEqual([]);
    });

    it('does not keep the baseline frontend dependency cycles', () => {
        const components = findStronglyConnectedComponents(collectEdges());
        const baselineCycles = [
            ['database', 'services/NativeService'],
            ['services/AgentService', 'services/AuthService'],
            ['services/AgentService', 'services/BuiltInToolService'],
            ['services/AgentService', 'types'],
            ['services/EventService', 'services/PopupService'],
            ['services/EventService', 'utils'],
            ['services/NativeService', 'utils'],
            ['services/PopupService', 'views/PopupView'],
        ];

        const retainedBaselineCycles = baselineCycles.filter((cycle) =>
            components.some((component) =>
                cycle.every((moduleName) => component.includes(moduleName))
            )
        );

        expect(retainedBaselineCycles.filter((cycle) => !isAllowedBaselineCycle(cycle))).toEqual(
            []
        );
    });
});
