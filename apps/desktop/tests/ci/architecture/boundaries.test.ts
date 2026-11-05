// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Linter } from 'eslint';
import * as tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import * as vueParser from 'vue-eslint-parser';

import {
    createArchitectureConfig,
    DECLARATION_FILE_GLOBS,
    describeTarget,
    resolveToAbsolute,
    SOURCE_FILE_PATTERNS,
} from '../../../scripts/ci/architecture/boundaries.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_TREE = path.resolve(testDirectory, 'fixtures/tree');
const RULE = 'touchai/import-boundaries';
const PACKAGE_RULE = '@typescript-eslint/no-restricted-imports';
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

function materialize(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-arch-'));
    cleanup.push(root);
    copyFixtureTree(FIXTURE_TREE, root);
    return root;
}

const projectRoot = materialize();
const srcRoot = path.join(projectRoot, 'src');
const aliases = {
    baseUrl: projectRoot,
    paths: {
        '@/*': ['src/*'],
        '@services/*': ['src/services/*'],
        '@database': ['src/database'],
        '@database/*': ['src/database/*'],
    },
};

const config: Linter.Config[] = [
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
    ...createArchitectureConfig({ projectRoot, srcRoot, aliases, globPrefix: '**' }),
];

const linter = new Linter({ cwd: projectRoot });

function violations(relativePath: string, ruleId = RULE): Linter.LintMessage[] {
    const filename = path.join(projectRoot, relativePath);
    const messages = linter.verify(fs.readFileSync(filename, 'utf8'), config, { filename });
    return messages.filter((message) => message.ruleId === ruleId);
}

afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

describe('user runs the architecture boundary gate', () => {
    describe('given a service that reaches into the Vue UI layer', () => {
        it('user sees a violation when the import uses an alias', () => {
            expect(violations('src/services/Demo/uiAlias.ts')).toHaveLength(1);
        });

        it('user sees a violation when the import uses a relative path', () => {
            expect(violations('src/services/Demo/uiRelative.ts')).toHaveLength(1);
        });

        it('user sees a violation when the import is dynamic', () => {
            expect(violations('src/services/Demo/uiDynamic.ts')).toHaveLength(1);
        });

        it('user sees no violation for a type-only import', () => {
            expect(violations('src/services/Demo/uiTypeOnly.ts')).toHaveLength(0);
        });

        it('user sees no violation for a type query import', () => {
            expect(violations('src/services/Demo/uiTypeQuery.ts')).toHaveLength(0);
        });

        it('user sees a violation in a TSX source file', () => {
            expect(violations('src/services/Demo/uiTsx.tsx')).toHaveLength(1);
        });

        it('user sees a violation in an MTS source file', () => {
            expect(violations('src/services/Demo/uiMts.mts')).toHaveLength(1);
        });
    });

    describe('given an internal module next to its own public barrel', () => {
        it('user sees a violation when the module imports its own index barrel', () => {
            expect(violations('src/services/Demo/helper.ts')).toHaveLength(1);
        });

        it('user sees no violation when the module imports a sibling directly', () => {
            expect(violations('src/services/Demo/helperGood.ts')).toHaveLength(0);
            expect(violations('src/services/Demo/index.ts')).toHaveLength(0);
        });
    });

    describe('given the public contracts layer', () => {
        it('user sees a violation when a contract imports executor internals', () => {
            expect(violations('src/services/AgentService/contracts/protocol.ts')).toHaveLength(1);
        });

        it('user sees no violation for a sibling contract import', () => {
            expect(violations('src/services/AgentService/contracts/tooling.ts')).toHaveLength(0);
        });
    });

    describe('given the service core and the Vue runtime packages', () => {
        it('user sees a violation for a static value import of vue', () => {
            expect(
                violations('src/services/Demo/vueStatic.ts', PACKAGE_RULE).length
            ).toBeGreaterThan(0);
        });

        it('user sees a violation for a dynamic import of vue', () => {
            expect(violations('src/services/Demo/vueDynamic.ts')).toHaveLength(1);
        });

        it('user sees no violation for a type-only import of vue', () => {
            expect(violations('src/services/Demo/vueTypeOnly.ts')).toHaveLength(0);
            expect(violations('src/services/Demo/vueTypeOnly.ts', PACKAGE_RULE)).toHaveLength(0);
        });
    });

    describe('given the database layer and a business service', () => {
        it('user sees a violation when the database imports a business service', () => {
            expect(violations('src/database/queries/models.ts')).toHaveLength(1);
        });

        it('user sees no violation when the database imports the NativeService bridge', () => {
            expect(violations('src/database/queries/native.ts')).toHaveLength(0);
        });

        it('user sees no violation for a type-only service import', () => {
            expect(violations('src/database/queries/policy.ts')).toHaveLength(0);
        });
    });

    describe('given a neutral domain module', () => {
        it('user sees a violation when the domain imports vue at runtime', () => {
            expect(violations('src/domain/models/noHost.ts', PACKAGE_RULE).length).toBeGreaterThan(
                0
            );
        });

        it('user sees a violation when the domain imports a Tauri runtime package', () => {
            expect(violations('src/domain/models/noTauri.ts', PACKAGE_RULE).length).toBeGreaterThan(
                0
            );
        });

        it('user sees a violation when the domain imports an upper UI layer', () => {
            expect(violations('src/domain/models/noUi.ts')).toHaveLength(1);
        });

        it('user sees no violation for a type-only contract import and a support import', () => {
            expect(violations('src/domain/models/ok.ts')).toHaveLength(0);
            expect(violations('src/domain/models/ok.ts', PACKAGE_RULE)).toHaveLength(0);
        });
    });

    describe('given a service that imports a .vue file outside views/components', () => {
        it('user sees a violation for a runtime import', () => {
            expect(violations('src/services/Demo/uiVueFile.ts')).toHaveLength(1);
        });

        it('user sees no violation for a type-only import', () => {
            expect(violations('src/services/Demo/uiVueFileTypeOnly.ts')).toHaveLength(0);
        });
    });

    describe('given a service that re-exports from the Vue UI layer', () => {
        it('user sees no violation for an inline type-only re-export', () => {
            expect(violations('src/services/Demo/uiTypeReExport.ts')).toHaveLength(0);
        });

        it('user sees a violation when a re-export has a runtime specifier', () => {
            expect(violations('src/services/Demo/uiTypeReExportMixed.ts')).toHaveLength(1);
        });
    });

    describe('given a service that imports another service', () => {
        it('user sees no violation for a cross-service public barrel import', () => {
            expect(violations('src/services/Demo/crossService.ts')).toHaveLength(0);
        });
    });

    describe('given production code that reaches for the offline database tooling', () => {
        it('user sees a violation for a runtime drizzle-orm import', () => {
            expect(violations('src/services/Demo/drizzleRuntime.ts')).toHaveLength(1);
        });

        it('user sees a violation for a dynamic drizzle-orm import', () => {
            expect(violations('src/services/Demo/drizzleDynamic.ts')).toHaveLength(1);
        });

        it('user sees a violation for a runtime schema import', () => {
            expect(violations('src/services/Demo/schemaRuntime.ts')).toHaveLength(1);
        });

        it('user sees no violation for a type-only schema import', () => {
            expect(violations('src/services/Demo/schemaTypeOnly.ts')).toHaveLength(0);
        });
    });
});

describe('user resolves module paths for the boundary gate', () => {
    it('user sees an alias and its relative form resolve to the same module', () => {
        const importer = path.join(srcRoot, 'services/Demo/uiAlias.ts');
        const viaAlias = resolveToAbsolute('@/views/Foo', importer, aliases);
        const viaRelative = resolveToAbsolute('../../views/Foo', importer, aliases);
        expect(viaAlias).toBe(viaRelative);
        expect(viaAlias).not.toBeNull();
        expect(describeTarget(viaAlias as string, { projectRoot, srcRoot }).srcRel).toBe(
            'views/Foo'
        );
    });

    it('user sees every wildcard in an alias target replaced', () => {
        const importer = path.join(srcRoot, 'services/Demo/crossService.ts');
        const multiWildcardAliases = {
            baseUrl: projectRoot,
            paths: {
                '@multi/*': ['src/*/entry-*.ts'],
            },
        };

        expect(resolveToAbsolute('@multi/model', importer, multiWildcardAliases)).toBe(
            path.join(srcRoot, 'model/entry-model.ts')
        );
    });

    it('user sees service and database specifiers classified into their layer', () => {
        const importer = path.join(srcRoot, 'services/Demo/crossService.ts');
        const serviceTarget = describeTarget(
            resolveToAbsolute('@services/Other', importer, aliases) as string,
            { projectRoot, srcRoot }
        );
        expect(serviceTarget.srcRel).toBe('services/Other/index');
        expect(serviceTarget.layer).toBe('services');

        const databaseTarget = describeTarget(
            resolveToAbsolute('@database/schema', importer, aliases) as string,
            { projectRoot, srcRoot }
        );
        expect(databaseTarget.layer).toBe('data');
    });
});
