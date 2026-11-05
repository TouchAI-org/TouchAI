// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { analyzeCycles, collectImports } from '../../../scripts/ci/architecture/check-cycles.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_TREE = path.resolve(testDirectory, 'fixtures/tree');
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

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-cycles-'));
cleanup.push(projectRoot);
copyFixtureTree(FIXTURE_TREE, projectRoot);
const srcRoot = path.join(projectRoot, 'src');

afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function sortedCycles(cycles: string[][]): string[] {
    return cycles.map((cycle) => cycle.join(' -> '));
}

describe('user reads import kinds from the parsed module graph', () => {
    it('user sees static, dynamic and type-only imports classified apart', () => {
        const code = [
            "import { a } from './a';",
            "import type { B } from './b';",
            "export { c } from './c';",
            "export type { D } from './d';",
            "const lazy = () => import('./e');",
            "type T = typeof import('./f');",
            'void a;',
            'void lazy;',
        ].join('\n');

        const edges = collectImports(code, path.join(srcRoot, 'probe.ts'));
        const byKind = new Map(edges.map((edge) => [edge.specifier, edge.kind]));

        expect(byKind.get('./a')).toBe('value');
        expect(byKind.get('./b')).toBe('type');
        expect(byKind.get('./c')).toBe('value');
        expect(byKind.get('./d')).toBe('type');
        expect(byKind.get('./e')).toBe('dynamic');
        expect(byKind.get('./f')).toBe('type');
    });
});

describe('user runs the runtime cycle gate over an isolated module tree', () => {
    const result = analyzeCycles({ projectRoot, srcRoot });

    describe('given a module barrel and its sibling import each other', () => {
        it('user sees the pair reported as a runtime cycle', () => {
            const cycles = sortedCycles(result.runtimeCycles);
            expect(cycles).toContain('services/Demo/helper -> services/Demo/index');
        });
    });

    describe('given two modules that only exchange type-only imports', () => {
        it('user sees the pair listed as a type-only cycle and not as a runtime cycle', () => {
            const runtime = sortedCycles(result.runtimeCycles);
            const typeOnly = sortedCycles(result.typeOnlyCycles);
            expect(typeOnly).toContain('services/TypeOnly/a -> services/TypeOnly/b');
            expect(runtime).not.toContain('services/TypeOnly/a -> services/TypeOnly/b');
        });
    });

    describe('given two modules that only re-export types inline', () => {
        it('user sees the pair listed as type-only and not as a runtime cycle', () => {
            const runtime = sortedCycles(result.runtimeCycles);
            const typeOnly = sortedCycles(result.typeOnlyCycles);
            const pair = 'services/Reexport/a -> services/Reexport/b';
            expect(typeOnly).toContain(pair);
            expect(runtime).not.toContain(pair);
        });
    });

    describe('given a cycle spanning TSX and MTS files', () => {
        it('user sees the pair reported as a runtime cycle', () => {
            expect(sortedCycles(result.runtimeCycles)).toContain(
                'services/MixedCycle/a -> services/MixedCycle/b'
            );
        });
    });

    describe('given a source file that does not parse', () => {
        it('user sees the gate report the parse error instead of a green result', () => {
            expect(result.parseErrors.map((item) => item.file)).toContain('broken/syntax-error');
        });
    });
});
