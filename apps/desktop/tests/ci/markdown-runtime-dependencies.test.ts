import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopManifestPath = join(process.cwd(), 'package.json');
const desktopRequire = createRequire(desktopManifestPath);
const desktopManifest = JSON.parse(readFileSync(desktopManifestPath, 'utf8')) as {
    dependencies: Record<string, string>;
};
const rendererDirectory = dirname(desktopRequire.resolve('markstream-vue/index.css'));
const runtimeEntry = join(rendererDirectory, 'monaco.js');
const runtimeSource = readFileSync(runtimeEntry, 'utf8');
const runtimeImports = Array.from(
    runtimeSource.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    (match) => match[1]!
);

describe('Markdown code block runtime dependencies', () => {
    it('loads the enhanced renderer with the same ESM semantics as markstream', () => {
        expect(runtimeImports.length).toBeGreaterThan(0);
        for (const dependency of runtimeImports) {
            expect(
                () =>
                    execFileSync(
                        process.execPath,
                        [
                            '--input-type=module',
                            '--eval',
                            `import assert from 'node:assert/strict';
                             const runtime = await import(${JSON.stringify(dependency)});
                             assert.equal(typeof (runtime.useMonaco ?? runtime.default?.useMonaco), 'function');`,
                        ],
                        // stream-diffs intentionally has import-only exports. A CJS
                        // require.resolve check rejects a valid browser ESM runtime.
                        { cwd: rendererDirectory, encoding: 'utf8', timeout: 15_000 }
                    ),
                `Missing Markdown code block runtime: ${dependency}`
            ).not.toThrow();
        }
    });

    it('declares the optional runtime peers explicitly so isolated installs include them', () => {
        for (const dependency of runtimeImports) {
            expect(
                desktopManifest.dependencies,
                `Undeclared Markdown runtime: ${dependency}`
            ).toHaveProperty(dependency);
        }
    });

    it('uses the upgraded File/Diff adapter instead of reverting to the legacy renderer', () => {
        expect(runtimeImports).toContain('stream-diffs');
    });
});
