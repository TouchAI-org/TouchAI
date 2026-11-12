import { describe, expect, it } from 'vitest';

import { readWorkflow, runClassifier } from './workflow-test-helpers';

const pullNumber = 726;
const beforeSha = 'a'.repeat(40);
const afterSha = 'b'.repeat(40);

const ciFallback = {
    docs_only: 'false',
    desktop_changed: 'true',
    site_changed: 'true',
    release_notes_changed: 'true',
};
const e2eFallback = {
    docs_only: 'false',
    desktop_changed: 'true',
};
const securityFallback = {
    docs_only: 'false',
    rust_changed: 'true',
};
const visualFallback = {
    ui_changed: 'true',
};
const releaseNotesFile = 'apps/desktop/release-notes/1.3.0-beta.3.json';

function pullRequestOptions(files: unknown[], changedFiles: number | null = files.length) {
    const pullRequest: Record<string, unknown> = { number: pullNumber };

    if (changedFiles !== null) {
        pullRequest.changed_files = changedFiles;
    }

    return {
        eventName: 'pull_request',
        pullRequestNumber: pullNumber,
        payload: {
            pull_request: pullRequest,
        },
        listFilePages: [files],
    };
}

function proseFiles(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        status: 'modified',
        filename: `docs/${index}.md`,
    }));
}

function pushOptions(files: unknown[], compareData: Record<string, unknown> = { files }) {
    return {
        eventName: 'push',
        payload: {
            before: beforeSha,
            after: afterSha,
        },
        compareData,
    };
}

function mergeGroupOptions(files: unknown[]) {
    return {
        eventName: 'merge_group',
        payload: {
            merge_group: {
                base_sha: beforeSha,
                head_sha: afterSha,
            },
        },
        compareData: { files },
    };
}

function renamed(previousFilename: unknown, filename: unknown): Record<string, unknown> {
    return {
        status: 'renamed',
        filename,
        previous_filename: previousFilename,
    };
}

const prosePaths = [
    { path: 'docs/guide/getting-started.mdx', label: 'getting started guide' },
    { path: 'docs/architecture/overview.md', label: 'architecture overview' },
    { path: 'README.md', label: 'main readme' },
    { path: 'README.en.md', label: 'English readme' },
    { path: 'CHANGELOG.md', label: 'changelog' },
    { path: 'COPYING', label: 'copying notice' },
    { path: 'CLAUDE.md', label: 'agent guidance notes' },
    { path: 'CODE_OF_CONDUCT.md', label: 'code of conduct' },
    { path: 'CONTRIBUTING.md', label: 'contributing guide' },
    { path: 'SECURITY.md', label: 'security policy' },
    { path: 'SUPPORT.md', label: 'support guide' },
    { path: '.github/ISSUE_TEMPLATE/bug_report.md', label: 'bug report template' },
    { path: '.github/dependabot.yml', label: 'dependency update configuration' },
    { path: '.github/labeler.yml', label: 'pull request labeling configuration' },
    { path: '.github/labels.yml', label: 'repository label configuration' },
    { path: '.github/pull_request_template.md', label: 'pull request template' },
];

describe('user changes prose under the existing allowlist', () => {
    it.each(prosePaths)(
        'user sees prose-only work skip desktop, site, Rust, and visual validation when the $label changes in a pull request',
        async ({ path }) => {
            const options = pullRequestOptions([{ status: 'modified', filename: path }]);

            expect((await runClassifier('ci.yml', options)).outputs).toEqual({
                docs_only: 'true',
                desktop_changed: 'false',
                site_changed: 'false',
                release_notes_changed: 'false',
            });
            expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual({
                docs_only: 'true',
                desktop_changed: 'false',
            });
            expect((await runClassifier('security.yml', options)).outputs).toEqual({
                docs_only: 'true',
                rust_changed: 'false',
            });
            expect((await runClassifier('visual-components.yml', options)).outputs).toEqual({
                ui_changed: 'false',
            });
        }
    );

    it('user sees docs-only push work skip desktop, site, and Rust validation while no-PR visuals keep running', async () => {
        const files = [
            { status: 'modified', filename: 'README.md' },
            { status: 'modified', filename: 'docs/guide/getting-started.mdx' },
        ];

        expect((await runClassifier('ci.yml', pushOptions(files))).outputs).toEqual({
            docs_only: 'true',
            desktop_changed: 'false',
            site_changed: 'false',
            release_notes_changed: 'false',
        });
        expect((await runClassifier('e2e-smoke.yml', pushOptions(files))).outputs).toEqual({
            docs_only: 'true',
            desktop_changed: 'false',
        });
        expect((await runClassifier('security.yml', pushOptions(files))).outputs).toEqual({
            docs_only: 'true',
            rust_changed: 'false',
        });
        expect(
            (await runClassifier('visual-components.yml', { eventName: 'push' })).outputs
        ).toEqual(visualFallback);
    });

    it('user sees mixed documentation and component work run all affected validation when both change', async () => {
        const files = [
            { status: 'modified', filename: 'README.md' },
            { status: 'modified', filename: 'apps/desktop/src/components/Button.vue' },
        ];

        expect((await runClassifier('ci.yml', pullRequestOptions(files))).outputs).toEqual({
            docs_only: 'false',
            desktop_changed: 'true',
            site_changed: 'false',
            release_notes_changed: 'false',
        });
        expect((await runClassifier('e2e-smoke.yml', pullRequestOptions(files))).outputs).toEqual({
            docs_only: 'false',
            desktop_changed: 'true',
        });
        expect((await runClassifier('security.yml', pullRequestOptions(files))).outputs).toEqual({
            docs_only: 'false',
            rust_changed: 'false',
        });
        expect(
            (await runClassifier('visual-components.yml', pullRequestOptions(files))).outputs
        ).toEqual({ ui_changed: 'true' });
    });

    it('user sees nested Markdown outside the prose allowlist run the affected site build', async () => {
        const files = [{ status: 'modified', filename: 'apps/site/content/README.md' }];

        expect((await runClassifier('ci.yml', pullRequestOptions(files))).outputs).toEqual({
            docs_only: 'false',
            desktop_changed: 'false',
            site_changed: 'true',
            release_notes_changed: 'false',
        });
        expect((await runClassifier('e2e-smoke.yml', pullRequestOptions(files))).outputs).toEqual({
            docs_only: 'false',
            desktop_changed: 'false',
        });
        expect((await runClassifier('security.yml', pullRequestOptions(files))).outputs).toEqual({
            docs_only: 'false',
            rust_changed: 'false',
        });
        expect(
            (await runClassifier('visual-components.yml', pullRequestOptions(files))).outputs
        ).toEqual({ ui_changed: 'false' });
    });
});

describe('user renames files across documentation and build inputs', () => {
    const rustRenameCases = [
        {
            scenario: 'a Rust source file becomes documentation',
            file: renamed('apps/desktop/src-tauri/src/lib.rs', 'docs/rust.md'),
        },
        {
            scenario: 'documentation becomes a Rust source file',
            file: renamed('docs/rust.md', 'apps/desktop/src-tauri/src/lib.rs'),
        },
    ];

    it.each(rustRenameCases)(
        'user sees both sides of a rename run desktop and Rust validation when $scenario',
        async ({ file }) => {
            const options = pullRequestOptions([file]);

            expect((await runClassifier('ci.yml', options)).outputs).toEqual({
                docs_only: 'false',
                desktop_changed: 'true',
                site_changed: 'false',
                release_notes_changed: 'false',
            });
            expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual({
                docs_only: 'false',
                desktop_changed: 'true',
            });
            expect((await runClassifier('security.yml', options)).outputs).toEqual({
                docs_only: 'false',
                rust_changed: 'true',
            });
            expect((await runClassifier('visual-components.yml', options)).outputs).toEqual({
                ui_changed: 'false',
            });
        }
    );

    const visualRenameCases = [
        {
            scenario: 'a visual component becomes documentation',
            file: renamed('apps/desktop/src/components/Button.vue', 'docs/components/button.md'),
        },
        {
            scenario: 'documentation becomes a visual component',
            file: renamed('docs/components/button.md', 'apps/desktop/src/components/Button.vue'),
        },
    ];

    it.each(visualRenameCases)(
        'user sees component visual validation when $scenario',
        async ({ file }) => {
            const options = pullRequestOptions([file]);

            expect((await runClassifier('ci.yml', options)).outputs).toEqual({
                docs_only: 'false',
                desktop_changed: 'true',
                site_changed: 'false',
                release_notes_changed: 'false',
            });
            expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual({
                docs_only: 'false',
                desktop_changed: 'true',
            });
            expect((await runClassifier('security.yml', options)).outputs).toEqual({
                docs_only: 'false',
                rust_changed: 'false',
            });
            expect((await runClassifier('visual-components.yml', options)).outputs).toEqual({
                ui_changed: 'true',
            });
        }
    );

    const siteRenameCases = [
        {
            scenario: 'a site document becomes repository documentation',
            file: renamed('apps/site/src/content/docs/index.mdx', 'docs/site.md'),
        },
        {
            scenario: 'repository documentation becomes a site document',
            file: renamed('docs/site.md', 'apps/site/src/content/docs/index.mdx'),
        },
    ];

    it.each(siteRenameCases)(
        'user sees site validation continue when $scenario',
        async ({ file }) => {
            const options = pullRequestOptions([file]);

            expect((await runClassifier('ci.yml', options)).outputs).toEqual({
                docs_only: 'false',
                desktop_changed: 'false',
                site_changed: 'true',
                release_notes_changed: 'false',
            });
            expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual({
                docs_only: 'false',
                desktop_changed: 'false',
            });
            expect((await runClassifier('security.yml', options)).outputs).toEqual({
                docs_only: 'false',
                rust_changed: 'false',
            });
            expect((await runClassifier('visual-components.yml', options)).outputs).toEqual({
                ui_changed: 'false',
            });
        }
    );
});

describe('user changes shared workspace and workflow inputs', () => {
    const sharedFrontendCases = [
        { path: 'packages/ui/src/index.ts', label: 'shared UI package' },
        { path: 'package.json', label: 'root package configuration' },
        { path: 'pnpm-workspace.yaml', label: 'workspace configuration' },
        { path: 'pnpm-lock.yaml', label: 'dependency lockfile' },
    ];

    it.each(sharedFrontendCases)(
        'user sees every shared frontend consumer run when the $label changes',
        async ({ path }) => {
            const options = pullRequestOptions([{ status: 'modified', filename: path }]);

            expect((await runClassifier('ci.yml', options)).outputs).toEqual({
                docs_only: 'false',
                desktop_changed: 'true',
                site_changed: 'true',
                release_notes_changed: 'false',
            });
            expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual({
                docs_only: 'false',
                desktop_changed: 'true',
            });
            expect((await runClassifier('security.yml', options)).outputs).toEqual({
                docs_only: 'false',
                rust_changed: 'false',
            });
            expect((await runClassifier('visual-components.yml', options)).outputs).toEqual({
                ui_changed: 'true',
            });
        }
    );

    const rootRustCases = [
        { path: '.cargo/config.toml', label: 'root Cargo configuration' },
        { path: 'Cargo.toml', label: 'root Rust manifest' },
        { path: 'Cargo.lock', label: 'root Rust lockfile' },
        { path: 'rust-toolchain', label: 'root Rust toolchain override' },
        { path: 'rust-toolchain.toml', label: 'root Rust toolchain configuration' },
    ];

    it.each(rootRustCases)(
        'user sees native and security validation run when the $label changes',
        async ({ path }) => {
            const options = pullRequestOptions([{ status: 'modified', filename: path }]);

            expect((await runClassifier('ci.yml', options)).outputs).toEqual({
                docs_only: 'false',
                desktop_changed: 'true',
                site_changed: 'false',
                release_notes_changed: 'false',
            });
            expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual({
                docs_only: 'false',
                desktop_changed: 'true',
            });
            expect((await runClassifier('security.yml', options)).outputs).toEqual({
                docs_only: 'false',
                rust_changed: 'true',
            });
            expect((await runClassifier('visual-components.yml', options)).outputs).toEqual({
                ui_changed: 'false',
            });
        }
    );

    const workflowCases = [
        {
            filename: 'ci.yml',
            path: '.github/workflows/ci.yml',
            workflowName: 'CI workflow',
        },
        {
            filename: 'e2e-smoke.yml',
            path: '.github/workflows/e2e-smoke.yml',
            workflowName: 'Desktop E2E Smoke workflow',
        },
        {
            filename: 'security.yml',
            path: '.github/workflows/security.yml',
            workflowName: 'Security workflow',
        },
        {
            filename: 'visual-components.yml',
            path: '.github/workflows/visual-components.yml',
            workflowName: 'Component Visual Tests workflow',
        },
    ];

    it.each(workflowCases)(
        'user sees the $workflowName run when its own definition changes',
        async ({ filename, path }) => {
            const options = pullRequestOptions([{ status: 'modified', filename: path }]);
            const { outputs } = await runClassifier(filename, options);

            expect(outputs.docs_only ?? 'false').toBe('false');
            expect(Object.values(outputs)).toContain('true');
        }
    );

    const nativeBuildInputCases = [
        { path: 'apps/desktop/src-tauri/build.rs', label: 'native build script' },
        { path: 'apps/desktop/src-tauri/Cargo.toml', label: 'native dependency manifest' },
        { path: 'apps/desktop/src-tauri/Cargo.lock', label: 'native dependency lockfile' },
        {
            path: 'apps/desktop/src-tauri/.cargo/config.toml',
            label: 'native Cargo configuration',
        },
        {
            path: 'apps/desktop/src-tauri/rust-toolchain',
            label: 'native Rust toolchain override',
        },
        {
            path: 'apps/desktop/src-tauri/rust-toolchain.toml',
            label: 'native Rust toolchain configuration',
        },
        {
            path: 'apps/desktop/src-tauri/tauri.conf.json',
            label: 'native application configuration',
        },
        {
            path: 'apps/desktop/src-tauri/vendor/everything/Everything.c',
            label: 'C library source',
        },
        {
            path: 'apps/desktop/src-tauri/vendor/include/Everything.h',
            label: 'C library header',
        },
        {
            path: 'apps/desktop/src-tauri/resources/rtk/manifest.json',
            label: 'bundled runtime manifest',
        },
        {
            path: 'apps/desktop/src-tauri/windows-common-controls.manifest',
            label: 'Windows application manifest',
        },
        {
            path: 'apps/desktop/src-tauri/capabilities/default.json',
            label: 'native capability configuration',
        },
        { path: 'apps/desktop/src-tauri/icons/icon.ico', label: 'application icon' },
        {
            path: 'apps/desktop/src/database/drizzle/0000_initial.sql',
            label: 'database schema artifact',
        },
        {
            path: 'apps/desktop/src/database/artifacts/runtime/seed.sql',
            label: 'runtime database seed',
        },
    ];

    it.each(nativeBuildInputCases)(
        'user sees native security analysis run when the $label changes',
        async ({ path }) => {
            const { outputs } = await runClassifier(
                'security.yml',
                pullRequestOptions([{ status: 'modified', filename: path }])
            );

            expect(outputs).toEqual({
                docs_only: 'false',
                rust_changed: 'true',
            });
        }
    );

    const embeddedNativeInputCases = [
        {
            scenario: 'a pull request modifies the embedded native update configuration',
            options: () =>
                pullRequestOptions([
                    {
                        status: 'modified',
                        filename: 'apps/desktop/product.json',
                    },
                ]),
        },
        {
            scenario:
                'a pull request renames repository documentation to the embedded native update configuration',
            options: () =>
                pullRequestOptions([renamed('docs/product.md', 'apps/desktop/product.json')]),
        },
        {
            scenario:
                'a pull request renames the embedded native update configuration to repository documentation',
            options: () =>
                pullRequestOptions([renamed('apps/desktop/product.json', 'docs/product.md')]),
        },
        {
            scenario: 'a main-branch push modifies the embedded native update configuration',
            options: () =>
                pushOptions([
                    {
                        status: 'modified',
                        filename: 'apps/desktop/product.json',
                    },
                ]),
        },
        {
            scenario:
                'a main-branch push renames repository documentation to the embedded native update configuration',
            options: () => pushOptions([renamed('docs/product.md', 'apps/desktop/product.json')]),
        },
        {
            scenario:
                'a main-branch push renames the embedded native update configuration to repository documentation',
            options: () => pushOptions([renamed('apps/desktop/product.json', 'docs/product.md')]),
        },
    ];

    it.each(embeddedNativeInputCases)(
        'user sees Rust security analysis run when $scenario',
        async ({ options }) => {
            const { outputs } = await runClassifier('security.yml', options());

            expect(outputs).toEqual({
                docs_only: 'false',
                rust_changed: 'true',
            });
        }
    );
});

describe('user relies on complete GitHub file inventories', () => {
    const invalidInventories: Array<{
        scenario: string;
        files: unknown[];
        changedFiles?: number | null;
    }> = [
        { scenario: 'the pull request has no files', files: [] },
        {
            scenario: 'a file has an empty name',
            files: [{ status: 'modified', filename: '' }],
        },
        {
            scenario: 'a file name is not text',
            files: [{ status: 'modified', filename: 42 }],
        },
        {
            scenario: 'a rename omits its previous name',
            files: [{ status: 'renamed', filename: 'docs/new.md' }],
        },
        {
            scenario: 'a rename has an empty previous name',
            files: [renamed('', 'docs/new.md')],
        },
        {
            scenario: 'a previous name is not text',
            files: [{ status: 'modified', filename: 'docs/new.md', previous_filename: 42 }],
        },
    ];

    it.each(invalidInventories)(
        'user sees conservative full validation when $scenario',
        async ({ files, changedFiles }) => {
            const options = pullRequestOptions(files, changedFiles ?? files.length);

            expect((await runClassifier('ci.yml', options)).outputs).toEqual(ciFallback);
            expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual(e2eFallback);
            expect((await runClassifier('security.yml', options)).outputs).toEqual(
                securityFallback
            );
            expect((await runClassifier('visual-components.yml', options)).outputs).toEqual(
                visualFallback
            );
        }
    );

    it('user sees all pull request files returned across pages before classification', async () => {
        const options = {
            eventName: 'pull_request',
            pullRequestNumber: pullNumber,
            payload: {
                pull_request: {
                    number: pullNumber,
                    changed_files: 2,
                },
            },
            listFilePages: [
                [{ status: 'modified', filename: 'docs/one.md' }],
                [{ status: 'modified', filename: 'docs/two.md' }],
            ],
        };
        const result = await runClassifier('ci.yml', options);

        expect(result.outputs).toEqual({
            docs_only: 'true',
            desktop_changed: 'false',
            site_changed: 'false',
            release_notes_changed: 'false',
        });
        expect(result.paginateCalls).toHaveLength(1);
        expect(result.paginateCalls[0]?.params).toEqual({
            owner: 'TouchAI-org',
            repo: 'TouchAI',
            pull_number: pullNumber,
            per_page: 100,
        });
    });

    it('user sees a pull request at the 3000-file cap run conservative full validation', async () => {
        const files = proseFiles(3_000);
        const options = pullRequestOptions(files);

        expect((await runClassifier('ci.yml', options)).outputs).toEqual(ciFallback);
        expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual(e2eFallback);
        expect((await runClassifier('security.yml', options)).outputs).toEqual(securityFallback);
        expect((await runClassifier('visual-components.yml', options)).outputs).toEqual(
            visualFallback
        );
    });

    const completeProsePullRequestClassifiers = [
        {
            workflowName: 'CI',
            filename: 'ci.yml',
            outputs: {
                docs_only: 'true',
                desktop_changed: 'false',
                site_changed: 'false',
                release_notes_changed: 'false',
            },
        },
        {
            workflowName: 'Desktop E2E Smoke',
            filename: 'e2e-smoke.yml',
            outputs: {
                docs_only: 'true',
                desktop_changed: 'false',
            },
        },
        {
            workflowName: 'Security',
            filename: 'security.yml',
            outputs: {
                docs_only: 'true',
                rust_changed: 'false',
            },
        },
        {
            workflowName: 'Component Visual Tests',
            filename: 'visual-components.yml',
            outputs: {
                ui_changed: 'false',
            },
        },
    ];
    const completeProsePullRequestBoundaries = [300, 2_999].flatMap((fileCount) =>
        [
            {
                fileCount,
                changedFiles: fileCount,
                countScenario: 'the reported count matches the inventory',
            },
            {
                fileCount,
                changedFiles: null,
                countScenario: 'the reported count is absent',
            },
        ].flatMap((inventory) =>
            completeProsePullRequestClassifiers.map((classifier) => ({
                ...inventory,
                ...classifier,
            }))
        )
    );

    it.each(completeProsePullRequestBoundaries)(
        'user sees $workflowName skip unrelated validation when a pull request contains $fileCount prose files and $countScenario',
        async ({ fileCount, changedFiles, filename, outputs }) => {
            const options = pullRequestOptions(proseFiles(fileCount), changedFiles);

            expect((await runClassifier(filename, options)).outputs).toEqual(outputs);
        }
    );

    it('user sees conservative full validation when the reported pull request file count differs from the inventory', async () => {
        const options = pullRequestOptions(
            [
                { status: 'modified', filename: 'docs/one.md' },
                { status: 'modified', filename: 'docs/two.md' },
            ],
            3
        );

        expect((await runClassifier('ci.yml', options)).outputs).toEqual(ciFallback);
        expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual(e2eFallback);
        expect((await runClassifier('security.yml', options)).outputs).toEqual(securityFallback);
        expect((await runClassifier('visual-components.yml', options)).outputs).toEqual(
            visualFallback
        );
    });

    it('user sees normal pull request routing when the reported file count is absent and the inventory is below the cap', async () => {
        const options = pullRequestOptions(
            [
                { status: 'modified', filename: 'docs/one.md' },
                { status: 'modified', filename: 'README.md' },
            ],
            null
        );

        expect((await runClassifier('ci.yml', options)).outputs).toEqual({
            docs_only: 'true',
            desktop_changed: 'false',
            site_changed: 'false',
            release_notes_changed: 'false',
        });
        expect((await runClassifier('security.yml', options)).outputs).toEqual({
            docs_only: 'true',
            rust_changed: 'false',
        });
    });

    const compareCapWorkflows = [
        { filename: 'ci.yml', workflowName: 'CI workflow' },
        { filename: 'e2e-smoke.yml', workflowName: 'Desktop E2E Smoke workflow' },
        { filename: 'security.yml', workflowName: 'Security workflow' },
    ];

    it.each(compareCapWorkflows)(
        'user sees the $workflowName run full validation when a comparison reaches its 300-file cap',
        async ({ filename }) => {
            const files = Array.from({ length: 300 }, (_, index) => ({
                status: 'modified',
                filename: `docs/${index}.md`,
            }));
            const result = await runClassifier(filename, pushOptions(files));
            const fallback =
                filename === 'ci.yml'
                    ? ciFallback
                    : filename === 'e2e-smoke.yml'
                      ? e2eFallback
                      : securityFallback;

            expect(result.outputs).toEqual(fallback);
        }
    );

    it.each(compareCapWorkflows)(
        'user sees the $workflowName route normally on a push below the 300-file comparison cap',
        async ({ filename }) => {
            const files = Array.from({ length: 299 }, (_, index) => ({
                status: 'modified',
                filename: `docs/${index}.md`,
            }));
            const result = await runClassifier(filename, pushOptions(files));
            const expected =
                filename === 'ci.yml'
                    ? {
                          docs_only: 'true',
                          desktop_changed: 'false',
                          site_changed: 'false',
                          release_notes_changed: 'false',
                      }
                    : filename === 'e2e-smoke.yml'
                      ? { docs_only: 'true', desktop_changed: 'false' }
                      : { docs_only: 'true', rust_changed: 'false' };

            expect(result.outputs).toEqual(expected);
            expect(result.compareCalls).toEqual([
                {
                    owner: 'TouchAI-org',
                    repo: 'TouchAI',
                    base: beforeSha,
                    head: afterSha,
                },
            ]);
        }
    );
});

describe('user changes release notes without runtime code', () => {
    const releaseNotes = [{ status: 'modified', filename: releaseNotesFile }];

    it('user sees a release-notes-only pull request skip product validation while retaining release checks', async () => {
        const options = pullRequestOptions(releaseNotes);

        expect((await runClassifier('ci.yml', options)).outputs).toEqual({
            docs_only: 'true',
            desktop_changed: 'false',
            site_changed: 'false',
            release_notes_changed: 'true',
        });
        expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual({
            docs_only: 'true',
            desktop_changed: 'false',
        });
        expect((await runClassifier('security.yml', options)).outputs).toEqual({
            docs_only: 'true',
            rust_changed: 'false',
        });
        expect((await runClassifier('visual-components.yml', options)).outputs).toEqual({
            ui_changed: 'false',
        });
    });

    it('user sees release notes and runtime code run both the notes check and product validation', async () => {
        const options = pullRequestOptions([
            ...releaseNotes,
            { status: 'modified', filename: 'apps/desktop/src/components/Button.vue' },
        ]);

        expect((await runClassifier('ci.yml', options)).outputs).toEqual({
            docs_only: 'false',
            desktop_changed: 'true',
            site_changed: 'false',
            release_notes_changed: 'true',
        });
        expect((await runClassifier('e2e-smoke.yml', options)).outputs).toEqual({
            docs_only: 'false',
            desktop_changed: 'true',
        });
        expect((await runClassifier('security.yml', options)).outputs).toEqual({
            docs_only: 'false',
            rust_changed: 'false',
        });
        expect((await runClassifier('visual-components.yml', options)).outputs).toEqual({
            ui_changed: 'true',
        });
    });

    it('user sees merge queue release-notes-only changes skip product validation using base and head', async () => {
        const options = mergeGroupOptions(releaseNotes);
        const ci = await runClassifier('ci.yml', options);
        const e2e = await runClassifier('e2e-smoke.yml', options);
        const visuals = await runClassifier('visual-components.yml', options);

        expect(ci.outputs).toEqual({
            docs_only: 'true',
            desktop_changed: 'false',
            site_changed: 'false',
            release_notes_changed: 'true',
        });
        expect(e2e.outputs).toEqual({
            docs_only: 'true',
            desktop_changed: 'false',
        });
        expect(visuals.outputs).toEqual({ ui_changed: 'false' });
        for (const result of [ci, e2e, visuals]) {
            expect(result.compareCalls).toEqual([
                {
                    owner: 'TouchAI-org',
                    repo: 'TouchAI',
                    base: beforeSha,
                    head: afterSha,
                },
            ]);
        }
    });
});

describe('user runs classifiers for supported event types', () => {
    it('user sees CI merge queue runs use full validation when the comparison is incomplete', async () => {
        const result = await runClassifier('ci.yml', {
            eventName: 'merge_group',
            payload: {
                merge_group: {
                    base_sha: beforeSha,
                    head_sha: afterSha,
                },
            },
            compareData: {},
        });

        expect(result.outputs).toEqual(ciFallback);
        expect(result.paginateCalls).toEqual([]);
        expect(result.compareCalls).toHaveLength(1);
    });

    it('user sees CI merge queue runs use full validation when the base is missing', async () => {
        const result = await runClassifier('ci.yml', {
            eventName: 'merge_group',
            payload: {
                merge_group: {
                    head_sha: afterSha,
                },
            },
        });

        expect(result.outputs).toEqual(ciFallback);
        expect(result.paginateCalls).toEqual([]);
        expect(result.compareCalls).toEqual([]);
    });

    it('user sees E2E merge queue docs-only changes skip desktop validation using base and head', async () => {
        const result = await runClassifier(
            'e2e-smoke.yml',
            mergeGroupOptions([{ status: 'modified', filename: 'docs/queue.md' }])
        );

        expect(result.outputs).toEqual({
            docs_only: 'true',
            desktop_changed: 'false',
        });
        expect(result.compareCalls).toEqual([
            {
                owner: 'TouchAI-org',
                repo: 'TouchAI',
                base: beforeSha,
                head: afterSha,
            },
        ]);
    });

    it('user sees E2E merge queue desktop changes run Windows validation', async () => {
        const result = await runClassifier(
            'e2e-smoke.yml',
            mergeGroupOptions([
                { status: 'modified', filename: 'docs/queue.md' },
                { status: 'modified', filename: 'apps/desktop/src/App.vue' },
            ])
        );

        expect(result.outputs).toEqual({
            docs_only: 'false',
            desktop_changed: 'true',
        });
    });

    const incompleteMergeGroups = [
        {
            scenario: 'the base is missing',
            mergeGroup: { head_sha: afterSha },
        },
        {
            scenario: 'the base is zero',
            mergeGroup: { base_sha: '0'.repeat(40), head_sha: afterSha },
        },
        {
            scenario: 'the head is missing',
            mergeGroup: { base_sha: beforeSha },
        },
    ];

    it.each(incompleteMergeGroups)(
        'user sees conservative E2E validation when $scenario',
        async ({ mergeGroup }) => {
            const result = await runClassifier('e2e-smoke.yml', {
                eventName: 'merge_group',
                payload: { merge_group: mergeGroup },
            });

            expect(result.outputs).toEqual(e2eFallback);
            expect(result.compareCalls).toEqual([]);
        }
    );

    const incompleteE2eComparisons = [
        { scenario: 'the comparison is empty', compareData: { files: [] } },
        { scenario: 'the comparison has no file list', compareData: {} },
        {
            scenario: 'the comparison reaches the cap',
            compareData: {
                files: Array.from({ length: 300 }, (_, index) => ({
                    status: 'modified',
                    filename: `docs/${index}.md`,
                })),
            },
        },
    ];

    it.each(incompleteE2eComparisons)(
        'user sees conservative E2E validation when $scenario',
        async ({ compareData }) => {
            const result = await runClassifier('e2e-smoke.yml', {
                eventName: 'merge_group',
                payload: {
                    merge_group: {
                        base_sha: beforeSha,
                        head_sha: afterSha,
                    },
                },
                compareData,
            });

            expect(result.outputs).toEqual(e2eFallback);
        }
    );

    it('user sees manual E2E runs validate everything without a comparison', async () => {
        const result = await runClassifier('e2e-smoke.yml', {
            eventName: 'workflow_dispatch',
        });

        expect(result.outputs).toEqual(e2eFallback);
        expect(result.paginateCalls).toEqual([]);
        expect(result.compareCalls).toEqual([]);
    });

    it.each([
        { eventName: 'schedule', label: 'scheduled invocation' },
        { eventName: 'workflow_dispatch', label: 'manual invocation' },
    ])(
        'user sees Security analysis run fully for a $label without classification',
        async ({ eventName }) => {
            const result = await runClassifier('security.yml', { eventName });

            expect(result.outputs).toEqual(securityFallback);
            expect(result.paginateCalls).toEqual([]);
            expect(result.compareCalls).toEqual([]);
        }
    );

    it.each([
        { eventName: 'push', label: 'main-branch push' },
        { eventName: 'workflow_dispatch', label: 'manual invocation' },
    ])(
        'user sees component visuals run fully for a $label without a pull request',
        async ({ eventName }) => {
            const result = await runClassifier('visual-components.yml', {
                eventName,
                payload: {},
            });

            expect(result.outputs).toEqual(visualFallback);
            expect(result.paginateCalls).toEqual([]);
        }
    );

    it('user sees component visuals classify merge queue changes from base and head', async () => {
        const result = await runClassifier(
            'visual-components.yml',
            mergeGroupOptions([
                { status: 'modified', filename: 'apps/desktop/src/components/Button.vue' },
            ])
        );

        expect(result.outputs).toEqual({ ui_changed: 'true' });
        expect(result.compareCalls).toEqual([
            {
                owner: 'TouchAI-org',
                repo: 'TouchAI',
                base: beforeSha,
                head: afterSha,
            },
        ]);
    });
});

describe('user receives a failure when GitHub cannot provide the file inventory', () => {
    it.each([
        { filename: 'ci.yml', workflowName: 'CI workflow' },
        { filename: 'e2e-smoke.yml', workflowName: 'Desktop E2E Smoke workflow' },
        { filename: 'security.yml', workflowName: 'Security workflow' },
        {
            filename: 'visual-components.yml',
            workflowName: 'Component Visual Tests workflow',
        },
    ])(
        'user sees the $workflowName fail instead of skipping validation when pull request files cannot be read',
        async ({ filename }) => {
            await expect(
                runClassifier(filename, {
                    ...pullRequestOptions([{ status: 'modified', filename: 'docs/guide.md' }]),
                    listFilesError: new Error('simulated pull file failure'),
                })
            ).rejects.toThrow('simulated pull file failure');
        }
    );

    it.each([
        { filename: 'ci.yml', workflowName: 'CI workflow' },
        { filename: 'e2e-smoke.yml', workflowName: 'Desktop E2E Smoke workflow' },
        { filename: 'security.yml', workflowName: 'Security workflow' },
    ])(
        'user sees the $workflowName fail instead of skipping validation when a push comparison fails',
        async ({ filename }) => {
            await expect(
                runClassifier(filename, {
                    ...pushOptions([]),
                    compareError: new Error('simulated comparison failure'),
                })
            ).rejects.toThrow('simulated comparison failure');
        }
    );
});

describe('user keeps required triggers present', () => {
    it('user sees each classifier workflow still declare its supported pull request and non-path-filtered trigger', () => {
        for (const filename of [
            'ci.yml',
            'e2e-smoke.yml',
            'security.yml',
            'visual-components.yml',
        ]) {
            const workflow = readWorkflow(filename);
            expect(workflow.on).toHaveProperty('pull_request');

            for (const configuration of Object.values(workflow.on)) {
                if (
                    configuration !== null &&
                    typeof configuration === 'object' &&
                    !Array.isArray(configuration)
                ) {
                    expect(configuration).not.toHaveProperty('paths');
                    expect(configuration).not.toHaveProperty('paths-ignore');
                }
            }
        }
    });
});
