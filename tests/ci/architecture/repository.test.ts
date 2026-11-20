import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../../tooling/architecture/check.mjs', import.meta.url));
const temporary: string[] = [];

function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'touchai-710-graph-'));
    temporary.push(root);
    const sources = {
        'apps/desktop/src/app/api/agent.ts': 'export const query = () => 1;',
        'packages/models/src/contracts/index.ts': 'export interface Message { content: string }',
        'packages/models/src/catalog/index.ts': 'export const catalog = [];',
        'packages/models/src/index.ts': 'export const createModels = () => ({});',
        'packages/models/src/providers/openai.ts': 'export const provider = {};',
        'packages/agent-core/src/contracts/index.ts': 'export interface Task { id: string }',
        'packages/agent-core/src/index.ts': 'export const createAgent = () => ({});',
        ...files,
    };
    for (const [file, content] of Object.entries(sources)) {
        const path = join(root, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }
    writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                module: 'ESNext',
                moduleResolution: 'bundler',
                paths: {
                    '@/*': ['./apps/desktop/src/*'],
                    '@touchai/models': ['./packages/models/src/index.ts'],
                    '@touchai/models/*': ['./packages/models/src/*'],
                    '@touchai/agent-core': ['./packages/agent-core/src/index.ts'],
                    '@touchai/agent-core/*': ['./packages/agent-core/src/*'],
                },
            },
            include: ['**/*.ts', '**/*.vue'],
        })
    );
    return root;
}

function run(root: string) {
    const result = spawnSync(process.execPath, [cli, '--project-root', resolve(root), '--json'], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
    for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('given public package and Desktop capability entries', () => {
    it('user can check legal neutral and presentation dependencies without loading providers', () => {
        const root = fixture({
            'packages/agent-core/src/task/turn.ts':
                "import type { Message } from '@touchai/models/contracts'; export type Turn = Message;",
            'apps/desktop/src/composables/useTask.ts':
                "import { query } from '@/app/api/agent'; export const value = query();",
        });
        const result = run(root);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).fileCount).toBeGreaterThan(0);
    });

    it.each([
        ["import { provider } from '@touchai/models/providers/openai';", 'package-dependency'],
        ["import type { Task } from '@touchai/agent-core/task/private';", 'package-entry'],
        ["import type { State } from '@/modules/models/state';", 'package-dependency'],
        ["export * from '@touchai/models/providers/openai';", 'package-dependency'],
        ["void import('@touchai/models/providers/openai');", 'package-dependency'],
    ])('user sees an illegal Core dependency rejected when the source uses %s', (source, code) => {
        const root = fixture({
            'packages/agent-core/src/task/turn.ts': source,
            'packages/agent-core/src/task/private.ts': 'export interface Task {}',
            'apps/desktop/src/modules/models/state.ts': 'export interface State {}',
        });
        const result = run(root);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(code);
    });
});

describe('given indirect business and presentation imports', () => {
    it.each([
        {
            label: 'static imports',
            source: "import { installOwner } from '@/app/bootstrap/owner'; export const owner = installOwner();",
        },
        { label: 'reexports', source: "export { installOwner } from '@/app/bootstrap/owner';" },
        {
            label: 'type imports',
            source: "import type { Owner } from '@/app/bootstrap/owner'; export type PageOwner = Owner;",
        },
        { label: 'dynamic imports', source: "void import('@/app/bootstrap/owner');" },
        {
            label: 'main entry imports',
            source: "import { installOwner } from '@/main'; export const owner = installOwner();",
        },
    ])('user sees a view bypassing its application API through $label rejected', ({ source }) => {
        const result = run(
            fixture({
                'apps/desktop/src/views/page.ts': source,
                'apps/desktop/src/app/bootstrap/owner.ts':
                    'export interface Owner { dispose(): void } export const installOwner = (): Owner => ({ dispose() {} });',
                'apps/desktop/src/main.ts': "export { installOwner } from '@/app/bootstrap/owner';",
            })
        );
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).violations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: 'ui-boundary',
                    from: 'apps/desktop/src/views/page.ts',
                }),
            ])
        );
    });

    it.each([
        [
            "import '@/utils/leak';",
            'apps/desktop/src/utils/leak.ts',
            "import '@/database/query';",
            'ui-boundary',
        ],
        [
            "export * from '@/utils/leak';",
            'apps/desktop/src/utils/leak.ts',
            "export * from '@/database/query';",
            'ui-boundary',
        ],
        [
            "void import('@/utils/leak');",
            'apps/desktop/src/utils/leak.ts',
            "import type { Row } from '@/database/query';",
            'ui-boundary',
        ],
        [
            "import './helper.js';",
            'apps/desktop/src/views/helper.ts',
            "import '@/database/query';",
            'ui-boundary',
        ],
    ])('user sees a SQL escape through %s rejected', (source, helper, helperSource, code) => {
        const result = run(
            fixture({
                'apps/desktop/src/views/page.ts': source,
                [helper]: helperSource,
                'apps/desktop/src/database/query.ts': 'export interface Row {}',
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(code);
    });

    it('user sees a Vue glob escape to module state rejected', () => {
        const result = run(
            fixture({
                'apps/desktop/src/views/Page.vue':
                    '<script setup lang="ts">const files = import.meta.glob("@/modules/models/*.ts");</script><template><div /></template>',
                'apps/desktop/src/modules/models/state.ts': 'export const state = 1;',
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('ui-boundary');
    });

    it('user sees a sibling module type dependency through a helper rejected', () => {
        const result = run(
            fixture({
                'apps/desktop/src/modules/agent/history.ts':
                    "import type { Model } from '@/utils/model'; export type History = Model;",
                'apps/desktop/src/utils/model.ts':
                    "export type { Model } from '@/modules/models/contracts';",
                'apps/desktop/src/modules/models/contracts.ts': 'export interface Model {}',
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('cross-module');
    });

    it('user sees platform and declarations rejected when they depend on business or presentation', () => {
        const result = run(
            fixture({
                'apps/desktop/src/platform/files/reader.ts': "import '@/modules/agent/history';",
                'apps/desktop/src/modules/agent/history.ts': 'export const history = [];',
                'packages/models/src/unsafe.d.ts':
                    "import type { Task } from '@touchai/agent-core/contracts'; export type Unsafe = Task;",
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('platform-boundary');
        expect(result.stdout).toContain('package-dependency');
    });

    it('user sees a runtime cycle rejected even when one edge is dynamic', () => {
        const result = run(
            fixture({
                'packages/agent-core/src/task/first.ts': "import './second';",
                'packages/agent-core/src/task/second.ts': "void import('./first');",
            })
        );
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).runtimeCycles).not.toEqual([]);
    });
});

describe('given an incomplete repository import graph', () => {
    it('user sees an unresolved constrained local import fail closed', () => {
        const result = run(
            fixture({
                'apps/desktop/src/modules/agent/history.ts': "import '@/missing/helper';",
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('unresolved-local');
    });

    it('user sees a nonliteral dynamic import fail closed', () => {
        const result = run(
            fixture({
                'packages/agent-core/src/task/first.ts':
                    'declare const entry: string; void import(entry);',
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('unresolved-dynamic');
    });

    it('user sees a missing root rejected rather than a zero-file success', () => {
        const root = fixture({});
        const result = run(join(root, 'missing'));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('invalid-project-root');
    });
});

describe('given distinct production, test and tooling graph roles', () => {
    it('user can replace native boundaries in a test without treating its invoke as production authority', () => {
        const result = run(
            fixture({
                'apps/desktop/tests/native.test.ts':
                    "import { invoke } from '@tauri-apps/api/core'; void invoke('fixture');",
                'apps/desktop/src/platform/native/invoke.ts':
                    "import { invoke } from '@tauri-apps/api/core'; export { invoke };",
            })
        );
        expect(result.status).toBe(0);
    });

    it('user can run parameterized browser and tooling fixtures without weakening production dynamic-import checks', () => {
        const result = run(
            fixture({
                'apps/desktop/tests/browser/layout.test.ts':
                    'declare const entry: string; void import(entry);',
                'scripts/ci/fixture.ts': 'declare const entry: string; void import(entry);',
            })
        );
        expect(result.status).toBe(0);
    });

    it.each(['apps/desktop/tests/missing.test.ts', 'scripts/ci/missing.ts'])(
        'user sees a missing literal import in %s fail rather than being hidden by its graph role',
        (file) => {
            const result = run(fixture({ [file]: "import './missing-source';" }));
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('unresolved-local');
        }
    );

    it('user cannot import a test-only native helper into newly discovered production source', () => {
        const result = run(
            fixture({
                'apps/desktop/src/future-capability/run.ts':
                    "export { execute } from '../../tests/helper';",
                'apps/desktop/tests/helper.ts':
                    "import { invoke } from '@tauri-apps/api/core'; export const execute = invoke;",
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('nonproduction-dependency');
    });

    it('user cannot disguise a production invoke or computed import by naming a source directory tests', () => {
        const result = run(
            fixture({
                'apps/desktop/src/tests/helper.ts':
                    "import { invoke } from '@tauri-apps/api/core'; declare const entry: string; void import(entry); export { invoke };",
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('raw-native-invoke');
        expect(result.stdout).toContain('unresolved-dynamic');
    });

    it('user can exercise a package-owned internal behavior in its own tests without opening that entry to Desktop', () => {
        const result = run(
            fixture({
                'packages/agent-core/src/task/decision.ts': 'export const decision = () => true;',
                'packages/agent-core/tests/decision.test.ts':
                    "import { decision } from '../src/task/decision'; void decision();",
            })
        );
        expect(result.status).toBe(0);
        const external = run(
            fixture({
                'packages/models/src/encoding/private.ts': 'export const encode = () => true;',
                'apps/desktop/tests/provider.test.ts':
                    "import { encode } from '../../../packages/models/src/encoding/private'; void encode();",
            })
        );
        expect(external.status).toBe(1);
        expect(external.stdout).toContain('package-entry');
    });

    it('user loads the actual main startup and translation support without granting either to database code', () => {
        const files = {
            'apps/desktop/src/main.ts': "import '@/app/bootstrap/start';",
            'apps/desktop/src/app/bootstrap/start.ts':
                "import '@/i18n'; import '@/platform/native/invoke';",
            'apps/desktop/src/i18n/index.ts':
                "import { createI18n } from 'vue-i18n'; export const language = createI18n({});",
            'apps/desktop/src/platform/native/invoke.ts':
                "import { invoke } from '@tauri-apps/api/core'; export { invoke };",
            'apps/desktop/src/vite-env.d.ts':
                "import type { DefineComponent } from 'vue'; export type View = DefineComponent;",
        };
        expect(run(fixture(files)).status).toBe(0);
        const result = run(
            fixture({ ...files, 'apps/desktop/src/database/query.ts': "import '@/i18n';" })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('platform-boundary');
    });
});

describe('given independently restricted production roles', () => {
    it.each(['index.ts', 'task/provider-helper.ts'])(
        'user cannot put a Provider SDK in the Core package at %s',
        (entry) => {
            const result = run(
                fixture({
                    [`packages/agent-core/src/${entry}`]:
                        "import { createOpenAI } from '@ai-sdk/openai'; export const createDriver = createOpenAI;",
                    ...(entry === 'index.ts'
                        ? {}
                        : {
                              'packages/agent-core/src/index.ts': `export { createDriver } from './${entry.replace(/\.ts$/, '')}';`,
                          }),
                })
            );
            expect(result.status).toBe(1);
            expect(JSON.parse(result.stdout).violations).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        code: 'package-dependency',
                        from: 'packages/agent-core/src/index.ts',
                    }),
                ])
            );
        }
    );

    it('user can use a reviewed neutral dependency in Core without permitting every external package', () => {
        const result = run(
            fixture({
                'packages/agent-core/package.json': JSON.stringify({
                    dependencies: { zod: '4.6.7' },
                    touchaiArchitecture: { neutralDependencies: ['zod'] },
                }),
                'packages/agent-core/src/contracts/validation.ts':
                    "import { z } from 'zod'; export const id = z.string();",
            })
        );
        expect(result.status).toBe(0);
    });

    it.each(['@ai-sdk/openai', 'future-provider-sdk'])(
        'user cannot authorize %s in Core just by adding an installed dependency',
        (sdk) => {
            const result = run(
                fixture({
                    'packages/agent-core/package.json': JSON.stringify({
                        dependencies: { [sdk]: '1.0.0' },
                        touchaiArchitecture: { neutralDependencies: [] },
                    }),
                    'packages/agent-core/src/index.ts': `export * from '${sdk}';`,
                })
            );
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('package-dependency');
        }
    );

    it.each([
        "export { assembleMain } from '@/app/composition/main';",
        "export { assembleMain } from '@/app/api/host-helper';",
        "export type HostFactory = typeof import('@/app/composition/main').assembleMain;",
        "export const loadHost = () => import('@/app/composition/main');",
    ])('user cannot expose main construction through an ordinary API using %s', (source) => {
        const result = run(
            fixture({
                'apps/desktop/src/views/page.ts':
                    "import * as commands from '@/app/api/agent'; export { commands };",
                'apps/desktop/src/app/api/agent.ts': source,
                'apps/desktop/src/app/api/host-helper.ts':
                    "export { assembleMain } from '@/app/composition/main';",
                'apps/desktop/src/app/composition/main.ts':
                    "import { createAgent } from '@touchai/agent-core'; export function assembleMain() { return createAgent(); }",
            })
        );
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).violations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: 'api-authority',
                    from: 'apps/desktop/src/app/api/agent.ts',
                }),
            ])
        );
    });

    it.each(['index', 'create'])(
        'user cannot expose a host-only model capability to an ordinary API through %s',
        (entry) => {
            const result = run(
                fixture({
                    'apps/desktop/src/app/api/models.ts':
                        "export { readConnectionState } from '@/app/api/model-helper';",
                    'apps/desktop/src/app/api/model-helper.ts': `export { readConnectionState } from '@/modules/models/${entry}';`,
                    [`apps/desktop/src/modules/models/${entry}.ts`]:
                        "export const readConnectionState = () => ({ apiKey: 'fixture' });",
                })
            );
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('module-role-entry');
        }
    );

    it('user can obtain explicitly safe module metadata through an ordinary API', () => {
        const result = run(
            fixture({
                'apps/desktop/src/app/api/models.ts':
                    "export { query } from '@/modules/models/public';",
                'apps/desktop/src/modules/models/public.ts':
                    'export const query = () => ({ configured: false });',
            })
        );
        expect(result.status).toBe(0);
    });
    it('user can bind a public module capability to its own designated storage boundary', () => {
        const result = run(
            fixture({
                'apps/desktop/src/modules/search/index.ts':
                    "export { createSearch } from './io/query';",
                'apps/desktop/src/modules/search/io/query.ts':
                    "import { query } from '@/database/query'; export const createSearch = () => ({ search: query });",
                'apps/desktop/src/database/query.ts': 'export const query = () => [];',
                'apps/desktop/src/app/composition/search.ts':
                    "import { createSearch } from '@/modules/search'; export const assembleSearch = createSearch;",
            })
        );
        expect(result.status).toBe(0);
    });

    it('user cannot let pure business code gain storage access through its own public capability entry', () => {
        const result = run(
            fixture({
                'apps/desktop/src/modules/search/index.ts':
                    "export { createSearch } from './io/query';",
                'apps/desktop/src/modules/search/io/query.ts':
                    "import { query } from '@/database/query'; export const createSearch = () => ({ search: query });",
                'apps/desktop/src/modules/search/ranking.ts':
                    "import { createSearch } from './index'; export const rank = createSearch;",
                'apps/desktop/src/database/query.ts': 'export const query = () => [];',
            })
        );
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).violations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: 'module-io',
                    from: 'apps/desktop/src/modules/search/ranking.ts',
                }),
            ])
        );
    });

    it('user cannot grant native SDK permissions to module I/O instead of a designated platform capability', () => {
        const result = run(
            fixture({
                'apps/desktop/src/modules/search/io/query.ts':
                    "import { readFile } from '@tauri-apps/plugin-fs'; export const read = readFile;",
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('module-io');
    });

    it('user cannot turn a module contract into a privileged I/O reexport', () => {
        const result = run(
            fixture({
                'apps/desktop/src/modules/search/contracts.ts':
                    "export { createSearch } from './io/query';",
                'apps/desktop/src/modules/search/io/query.ts':
                    "import { query } from '@/database/query'; export const createSearch = () => ({ search: query });",
                'apps/desktop/src/database/query.ts': 'export const query = () => [];',
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('module-io');
    });

    it('user cannot create an execution host from an agent module instead of main assembly', () => {
        const result = run(
            fixture({
                'apps/desktop/src/modules/agent/start.ts':
                    "import { createAgent } from '@touchai/agent-core'; export const agent = createAgent();",
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('execution-host-entry');
    });

    it('user cannot grant presentation state to a business module by naming an I/O directory', () => {
        const result = run(
            fixture({
                'apps/desktop/src/modules/search/io/source.ts':
                    "import { ref } from 'vue'; export const state = ref(0);",
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('module-framework');
    });

    it.each(['fs', 'fs/promises', 'node:fs', 'node:fs/promises', 'path', 'node:test'])(
        'user cannot read native resources from a models driver using the %s builtin spelling',
        (builtin) => {
            const result = run(
                fixture({
                    'packages/models/src/providers/unsafe.ts': `import * as native from '${builtin}'; export { native };`,
                })
            );
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('package-dependency');
        }
    );

    it('user sees an unreferenced neutral helper rejected when it exposes SQL', () => {
        const result = run(
            fixture({
                'apps/desktop/src/utils/leaky.ts': "export * from '@/database/query';",
                'apps/desktop/src/database/query.ts': 'export const query = () => 1;',
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('neutral-boundary');
    });

    it.each(['vercel-minimax-ai-provider', 'zhipu-ai-provider', '@ai-sdk/openai', 'ai'])(
        'user cannot eagerly load %s through a neutral models contract',
        (sdk) => {
            const result = run(
                fixture({
                    'packages/models/src/contracts/unsafe.ts': `import * as provider from '${sdk}'; export { provider };`,
                })
            );
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('neutral-model-entry');
        }
    );

    it('user can create the sole execution host through the exact main assembly entry', () => {
        const result = run(
            fixture({
                'apps/desktop/src/app/composition/main.ts':
                    "import { createAgent } from '@touchai/agent-core'; export function assembleMain() { return createAgent(); }",
            })
        );
        expect(result.status).toBe(0);
    });
});

describe('given presentation APIs that must not grant new execution authority', () => {
    it.each([
        "export { query } from '@/database/query';",
        "export { query } from '@/app/api/helper';",
        "export type Query = typeof import('@/database/query').query;",
        "export const query = () => import('@/database/query');",
    ])('user cannot expose raw SQL through an API using %s', (source) => {
        const result = run(
            fixture({
                'apps/desktop/src/app/api/query.ts': source,
                'apps/desktop/src/app/api/helper.ts': "export { query } from '@/database/query';",
                'apps/desktop/src/database/query.ts': 'export const query = () => [];',
            })
        );
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).violations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: 'api-authority',
                    from: 'apps/desktop/src/app/api/query.ts',
                }),
            ])
        );
    });

    it.each([
        "export { readFile } from '@tauri-apps/plugin-fs';",
        "export { readFile } from 'node:fs';",
        "export { readFile } from '@/platform/files';",
        "export { invoke } from '@/platform/native/invoke';",
        "export { provider } from '@touchai/models/providers/openai';",
        "export { createModels } from '@touchai/models';",
        "export { driver } from '@ai-sdk/openai';",
        "export { driver } from 'future-provider-sdk';",
        "export { execute } from '@/app/workflows/run';",
    ])('user cannot turn an ordinary API into a host using %s', (source) => {
        const result = run(
            fixture({
                'apps/desktop/src/app/api/unsafe.ts': source,
                'apps/desktop/src/platform/files/index.ts':
                    "export { readFile } from '@tauri-apps/plugin-fs';",
                'apps/desktop/src/platform/native/invoke.ts':
                    "export { invoke } from '@tauri-apps/api/core';",
                'apps/desktop/src/app/workflows/run.ts': 'export const execute = () => true;',
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('api-authority');
    });

    it('user can keep a reviewed attachment preview bridge without admitting filesystem reads', () => {
        const files = {
            'apps/desktop/src/app/api/attachments/presentation.ts':
                "export { convertFileSrc as attachmentPreviewUrl } from '@/platform/files';",
            'apps/desktop/src/platform/files/index.ts':
                "export { convertFileSrc } from '@tauri-apps/api/core'; export { readFile } from '@tauri-apps/plugin-fs';",
            'apps/desktop/src/app/api/query.ts':
                "export { attachmentPreviewUrl } from '@/app/api/attachments/presentation';",
        };
        expect(run(fixture(files)).status).toBe(0);
        const result = run(
            fixture({
                ...files,
                'apps/desktop/src/app/api/attachments/presentation.ts':
                    "export { convertFileSrc, readFile } from '@/platform/files';",
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('api-authority');
    });

    it('user can share workflow contracts but cannot hide execution in the contract entry', () => {
        const files = {
            'apps/desktop/src/app/api/settings/dataManagement.ts':
                "export { DataManagementError } from '@/app/workflows/data-management/contracts';",
            'apps/desktop/src/app/workflows/data-management/contracts.ts':
                'export class DataManagementError extends Error {}',
        };
        expect(run(fixture(files)).status).toBe(0);
        const result = run(
            fixture({
                ...files,
                'apps/desktop/src/app/workflows/data-management/contracts.ts':
                    "export { execute as DataManagementError } from './run';",
                'apps/desktop/src/app/workflows/data-management/run.ts':
                    'export const execute = () => true;',
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('api-authority');
    });

    it('user can read neutral model metadata through its encoding helpers without admitting an SDK', () => {
        const files = {
            'apps/desktop/src/app/api/models/catalog.ts':
                "export { parse } from '@touchai/models/catalog';",
            'packages/models/src/catalog/index.ts': "export { parse } from '../encoding/json';",
            'packages/models/src/encoding/json.ts': 'export const parse = JSON.parse;',
        };
        expect(run(fixture(files)).status).toBe(0);
        const result = run(
            fixture({
                ...files,
                'packages/models/src/encoding/json.ts':
                    "export { createOpenAI as parse } from '@ai-sdk/openai';",
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('api-authority');
        expect(result.stdout).toContain('neutral-model-entry');
    });

    it.each(['app/api/unsafe.ts', 'app/workflows/unsafe.ts', 'adapters/unsafe.ts'])(
        'user cannot couple %s to presentation state or owner construction',
        (entry) => {
            for (const target of ['stores/query.ts', 'app/bootstrap/query.ts']) {
                const result = run(
                    fixture({
                        [`apps/desktop/src/${entry}`]: `export { query } from '@/${target.slice(0, -3)}';`,
                        [`apps/desktop/src/${target}`]: 'export const query = () => true;',
                    })
                );
                expect(result.status).toBe(1);
                expect(result.stdout).toContain(
                    entry.startsWith('app/api/') ? 'api-authority' : 'orchestration-boundary'
                );
            }
        }
    );
});

describe('given root Tauri exports beside the designated invoke adapter', () => {
    it.each([
        "import { core } from '@tauri-apps/api'; export const run = core.invoke;",
        "export { core as native } from '@tauri-apps/api';",
        "export { core as native } from '@tauri-apps/api/index';",
        "import * as tauri from '@tauri-apps/api'; export const run = tauri.core.invoke;",
        "export const load = () => import('@tauri-apps/api');",
    ])('user cannot bypass the invoke adapter using %s', (source) => {
        const result = run(fixture({ 'apps/desktop/src/platform/windows/unsafe.ts': source }));
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('raw-native-invoke');
    });

    it('user can import unrelated root Tauri capabilities without acquiring raw invoke', () => {
        const result = run(
            fixture({
                'apps/desktop/src/platform/windows/path.ts':
                    "import { path } from '@tauri-apps/api'; export const join = path.join;",
            })
        );
        expect(result.status).toBe(0);
    });
});

describe('given the former architecture review bypasses', () => {
    it('user sees a dynamic Vue runtime subpath rejected when a business module imports it', () => {
        const result = run(
            fixture({
                'apps/desktop/src/modules/search/source.ts':
                    "export const load = () => import('vue/dist/vue.runtime.esm-bundler.js');",
            })
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('module-framework');
    });

    it('user can keep an erased import-equals cycle when both model contracts contain only types', () => {
        const result = run(
            fixture({
                'packages/models/src/contracts/first.ts':
                    "import type Second = require('./second'); export type First = Second.Second;",
                'packages/models/src/contracts/second.ts':
                    "import type First = require('./first'); export interface Second { next?: First.First }",
            })
        );
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).runtimeCycles).toEqual([]);
    });

    it('user sees a malformed Vue file rejected when a valid TypeScript file has the same stem', () => {
        const result = run(
            fixture({
                'apps/desktop/src/components/Widget.ts': 'export const label = "fixture";',
                'apps/desktop/src/components/Widget.vue':
                    '<script setup lang="ts">const broken = ;</script><template><div /></template>',
            })
        );
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).parseErrors).toEqual([
            expect.objectContaining({ file: 'apps/desktop/src/components/Widget.vue' }),
        ]);
    });

    it('user sees an absent package source tree rejected when the rest of a selected project is valid', () => {
        const root = fixture({});
        rmSync(join(root, 'packages/agent-core/src'), { recursive: true });
        const result = run(root);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('invalid-source-root');
        expect(result.stderr).toContain('packages/agent-core/src');
    });
});
