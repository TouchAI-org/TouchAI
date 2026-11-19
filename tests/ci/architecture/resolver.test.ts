import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createModuleResolver } from '../../../tooling/architecture/module-resolver.mjs';

const roots: string[] = [];

function fixture(target = './src/*') {
    const root = mkdtempSync(join(tmpdir(), 'touchai-alias-'));
    roots.push(root);
    const files = {
        'src/index.ts': 'export {};',
        'src/literal/$&/entry.ts': 'export const value = 1;',
        'src/literal/other/entry.ts': 'export const value = 2;',
        'src/plain.ts': 'export const value = 3;',
        'tsconfig.json': JSON.stringify({
            compilerOptions: {
                module: 'ESNext',
                moduleResolution: 'bundler',
                paths: { '@/*': [target], '@plain': ['./src/plain.ts'] },
            },
            include: ['src/**/*.ts'],
        }),
    };
    for (const [file, contents] of Object.entries(files)) {
        const filename = join(root, file);
        mkdirSync(dirname(filename), { recursive: true });
        writeFileSync(filename, contents);
    }
    return { root, resolver: createModuleResolver(root), importer: join(root, 'src/index.ts') };
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('given glob imports resolved through TypeScript aliases', () => {
    it('user scans only the literal directory when its alias contains a dollar replacement sequence', () => {
        const { root, resolver, importer } = fixture();
        expect(resolver.expandGlob('@/literal/$&/*.ts', importer)).toEqual([
            join(root, 'src/literal/$&/entry.ts'),
        ]);
    });

    it('user scans a fixed alias and an ordinary wildcard alias without losing source files', () => {
        const { root, resolver, importer } = fixture();
        expect(resolver.expandGlob('@plain', importer)).toEqual([join(root, 'src/plain.ts')]);
        expect(resolver.expandGlob('@/literal/other/*.ts', importer)).toEqual([
            join(root, 'src/literal/other/entry.ts'),
        ]);
    });

    it('user receives an explicit configuration error when an alias target contains multiple wildcards', () => {
        const { resolver, importer } = fixture('./src/*/*');
        expect(() => resolver.expandGlob('@/literal/*.ts', importer)).toThrow(
            '[invalid-glob-alias]'
        );
    });
});
