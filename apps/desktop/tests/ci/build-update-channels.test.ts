import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

type ChannelLatestFixture = {
    version: string;
    tag: string;
    releaseUrl: string;
    publishedAt: string | null;
    prerelease: boolean;
    releaseNotes?: string | null;
    downloads?: ChannelDownloadFixture[];
};
type ChannelDownloadFixture = {
    kind: 'installer' | 'fullPackage' | 'deltaPackage' | 'updatePackage' | 'asset';
    name: string;
    url: string;
    sizeBytes: number | null;
};
type BuildUpdateChannels = (
    projectRoot: string,
    outputRoot: string,
    now?: Date,
    options?: {
        fetchExisting?: boolean;
        release?: {
            channel: string;
            version: string;
            tag: string;
            publishedAt?: string | null;
            prerelease: boolean;
            releaseNotesFile?: string | null;
            releaseDir?: string | null;
        } | null;
        latestByChannel?: Record<string, ChannelLatestFixture | null>;
    }
) => Promise<void>;
type ProductConfigFixture = {
    schemaVersion: number;
    product: string;
    displayName: string;
    identifier: string;
    repository: {
        url: string;
        releasesUrl: string;
        docsUrl: string;
        issuesUrl: string;
    };
    packaging: {
        mainExe: string;
    };
    services: {
        updates: {
            baseUrl: string;
            deployment: {
                provider: string;
                bucketName: string;
            };
            channels: Record<
                string,
                {
                    displayName?: string;
                    policy: {
                        minimumSupportedVersion: string | null;
                        requiredSeverity: string | null;
                        requiredReason: string | null;
                    };
                }
            >;
        };
    };
};

async function loadBuilder(): Promise<BuildUpdateChannels | undefined> {
    try {
        const module = await import('../../scripts/ci/build-update-channels.mjs');
        return module.buildUpdateChannels as BuildUpdateChannels;
    } catch {
        return undefined;
    }
}

async function createFixture(product: unknown) {
    const root = await mkdtemp(join(tmpdir(), 'touchai-update-channels-'));
    await writeFile(join(root, 'product.json'), `${JSON.stringify(product, null, 4)}\n`, 'utf8');
    return root;
}

function cloneProductConfig(): ProductConfigFixture {
    return JSON.parse(JSON.stringify(APP_PRODUCT_CONFIG)) as ProductConfigFixture;
}

function updatePathSegments(baseUrl: string): string[] {
    return new URL(baseUrl).pathname
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(Boolean);
}

function channelOutputPath(product: ProductConfigFixture, outputRoot: string, channel: string) {
    return join(updateOutputDir(product, outputRoot), `releases.${channel}.json`);
}

function updateOutputDir(product: ProductConfigFixture, outputRoot: string) {
    return join(outputRoot, ...updatePathSegments(product.services.updates.baseUrl));
}

function updateFeedUrl(product: ProductConfigFixture, channel: string) {
    return `${product.services.updates.baseUrl.replace(/\/+$/g, '')}/releases.${channel}.json`;
}

async function withMockedExistingFeeds(
    feeds: Record<string, unknown>,
    run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>
) {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = input.toString();
        const feed = feeds[url];

        if (feed) {
            return {
                ok: true,
                status: 200,
                json: async () => feed,
            } as Response;
        }

        return {
            ok: false,
            status: 404,
            json: async () => null,
        } as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
        await run(fetchMock);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function withStableRequiredPolicy() {
    const product = cloneProductConfig();
    product.services.updates.channels.stable!.policy = {
        minimumSupportedVersion: '0.2.1',
        requiredSeverity: 'critical',
        requiredReason: 'Security update required',
    };
    return product;
}

describe('buildUpdateChannels', () => {
    it('builds one JSON file per update channel', async () => {
        const buildUpdateChannels = await loadBuilder();
        const productFixture = withStableRequiredPolicy();
        const root = await createFixture(productFixture);
        const outputRoot = join(root, 'dist');

        try {
            expect(buildUpdateChannels).toBeTypeOf('function');
            await buildUpdateChannels?.(root, outputRoot, new Date('2026-05-24T00:00:00Z'));

            const stable = JSON.parse(
                await readFile(channelOutputPath(productFixture, outputRoot, 'stable'), 'utf8')
            );
            const beta = JSON.parse(
                await readFile(channelOutputPath(productFixture, outputRoot, 'beta'), 'utf8')
            );

            expect(stable).toEqual({
                Assets: [],
                SchemaVersion: 1,
                Product: productFixture.product,
                DisplayName: productFixture.displayName,
                Channel: 'stable',
                GeneratedAt: '2026-05-24T00:00:00.000Z',
                Latest: null,
                Policy: {
                    minimumSupportedVersion: '0.2.1',
                    requiredSeverity: 'critical',
                    requiredReason: 'Security update required',
                },
            });
            expect(beta.Policy.minimumSupportedVersion).toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects invalid policy versions', async () => {
        const buildUpdateChannels = await loadBuilder();
        const productFixture = cloneProductConfig();
        const root = await createFixture({
            ...productFixture,
            services: {
                updates: {
                    ...productFixture.services.updates,
                    channels: {
                        ...productFixture.services.updates.channels,
                        stable: {
                            policy: {
                                minimumSupportedVersion: 'latest',
                            },
                        },
                    },
                },
            },
        });
        const outputRoot = join(root, 'dist');

        try {
            expect(buildUpdateChannels).toBeTypeOf('function');
            await expect(buildUpdateChannels?.(root, outputRoot)).rejects.toThrow(
                'stable.minimumSupportedVersion must be a semantic version or null.'
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('derives product, channel names, and output path from product.json', async () => {
        const buildUpdateChannels = await loadBuilder();
        const productFixture = cloneProductConfig();
        const derivedBaseUrl = new URL(productFixture.services.updates.baseUrl);
        const derivedProductName = `${productFixture.product}-fixture`;
        derivedBaseUrl.pathname = `/${derivedProductName}/v2`;
        const customProduct = {
            ...productFixture,
            product: derivedProductName,
            services: {
                updates: {
                    ...productFixture.services.updates,
                    baseUrl: derivedBaseUrl.toString(),
                },
            },
        };
        const root = await createFixture(customProduct);
        const outputRoot = join(root, 'dist');

        try {
            expect(buildUpdateChannels).toBeTypeOf('function');
            await buildUpdateChannels?.(root, outputRoot, new Date('2026-05-24T00:00:00Z'));

            const stable = JSON.parse(
                await readFile(channelOutputPath(customProduct, outputRoot, 'stable'), 'utf8')
            );

            expect(stable.Product).toBe(derivedProductName);
            expect(stable.Channel).toBe('stable');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('includes latest release metadata when provided by the release workflow', async () => {
        const buildUpdateChannels = await loadBuilder();
        const productFixture = cloneProductConfig();
        const root = await createFixture(productFixture);
        const outputRoot = join(root, 'dist');
        const releaseDir = join(root, 'release');
        const releaseNotesPath = join(root, 'release-notes.md');
        const installerName = 'TouchAI-beta-0.1.1-beta.1-windows.msi';
        const fullPackageName = 'TouchAI-beta-0.1.1-beta.1-windows-full.nupkg';
        const deltaPackageName = 'TouchAI-beta-0.1.1-beta.1-windows-delta.nupkg';
        const stalePrefixMatchName = 'TouchAI-beta-0.1.1-beta.10-windows-full.nupkg';
        const releaseTag = 'v0.1.1-beta.1';
        const expectedReleaseUrl = `${productFixture.repository.releasesUrl}/tag/${releaseTag}`;
        const expectedDownloadBaseUrl = productFixture.services.updates.baseUrl.replace(
            /\/+$/g,
            ''
        );
        await mkdir(releaseDir, { recursive: true });
        await writeFile(releaseNotesPath, '## Changes\n\n- Beta fixes\n', 'utf8');
        await writeFile(join(releaseDir, installerName), 'installer');
        await writeFile(join(releaseDir, fullPackageName), 'full');
        await writeFile(join(releaseDir, deltaPackageName), 'delta');
        await writeFile(join(releaseDir, stalePrefixMatchName), 'stale full');
        await writeFile(
            join(releaseDir, 'releases.beta.json'),
            JSON.stringify(
                {
                    Assets: [
                        {
                            PackageId: productFixture.identifier,
                            Version: '0.1.1-beta.1',
                            Type: 'Full',
                            FileName: fullPackageName,
                            SHA1: '',
                            SHA256: '',
                            Size: 4,
                            NotesMarkdown: '## Changes\n\n- Beta fixes',
                            NotesHtml: '',
                        },
                        {
                            PackageId: productFixture.identifier,
                            Version: '0.1.1-beta.1',
                            Type: 'Delta',
                            FileName: deltaPackageName,
                            SHA1: '',
                            SHA256: '',
                            Size: 5,
                            NotesMarkdown: '## Changes\n\n- Beta fixes',
                            NotesHtml: '',
                        },
                    ],
                },
                null,
                4
            ),
            'utf8'
        );

        try {
            expect(buildUpdateChannels).toBeTypeOf('function');
            await buildUpdateChannels?.(root, outputRoot, new Date('2026-05-24T00:00:00Z'), {
                release: {
                    channel: 'beta',
                    version: '0.1.1-beta.1',
                    tag: releaseTag,
                    publishedAt: '2026-05-24T16:37:32.103Z',
                    prerelease: true,
                    releaseNotesFile: releaseNotesPath,
                    releaseDir,
                },
            });

            const beta = JSON.parse(
                await readFile(channelOutputPath(productFixture, outputRoot, 'beta'), 'utf8')
            );
            const stable = JSON.parse(
                await readFile(channelOutputPath(productFixture, outputRoot, 'stable'), 'utf8')
            );

            expect(beta.Latest).toEqual({
                version: '0.1.1-beta.1',
                tag: releaseTag,
                releaseUrl: expectedReleaseUrl,
                publishedAt: '2026-05-24T16:37:32.103Z',
                prerelease: true,
                releaseNotes: '## Changes\n\n- Beta fixes',
                downloads: [
                    {
                        kind: 'installer',
                        name: installerName,
                        url: `${expectedDownloadBaseUrl}/${installerName}`,
                        sizeBytes: 9,
                    },
                    {
                        kind: 'fullPackage',
                        name: fullPackageName,
                        url: `${expectedDownloadBaseUrl}/${fullPackageName}`,
                        sizeBytes: 4,
                    },
                    {
                        kind: 'deltaPackage',
                        name: deltaPackageName,
                        url: `${expectedDownloadBaseUrl}/${deltaPackageName}`,
                        sizeBytes: 5,
                    },
                ],
            });
            expect(beta.Assets).toHaveLength(2);
            expect(stable.Latest).toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('uses existing feeds when fetchExisting is true and no new release is provided', async () => {
        const buildUpdateChannels = await loadBuilder();
        const productFixture = cloneProductConfig();
        const root = await createFixture(productFixture);
        const outputRoot = join(root, 'dist');
        const stableAsset = {
            PackageId: productFixture.identifier,
            Version: '0.2.0',
            Type: 'Full',
            FileName: 'TouchAI-0.2.0-windows-full.nupkg',
            SHA1: '',
            SHA256: '',
            Size: 4,
        };
        const betaAsset = {
            PackageId: productFixture.identifier,
            Version: '0.2.1-beta.1',
            Type: 'Full',
            FileName: 'TouchAI-0.2.1-beta.1-windows-full.nupkg',
            SHA1: '',
            SHA256: '',
            Size: 5,
        };
        const stableLatest: ChannelLatestFixture = {
            version: '0.2.0',
            tag: 'v0.2.0',
            releaseUrl: `${productFixture.repository.releasesUrl}/tag/v0.2.0`,
            publishedAt: '2026-05-22T09:00:00.000Z',
            prerelease: false,
            releaseNotes: '## Stable',
            downloads: [
                {
                    kind: 'fullPackage',
                    name: stableAsset.FileName,
                    url: `${productFixture.services.updates.baseUrl.replace(/\/+$/g, '')}/${stableAsset.FileName}`,
                    sizeBytes: 4,
                },
            ],
        };
        const betaLatest: ChannelLatestFixture = {
            version: '0.2.1-beta.1',
            tag: 'v0.2.1-beta.1',
            releaseUrl: `${productFixture.repository.releasesUrl}/tag/v0.2.1-beta.1`,
            publishedAt: '2026-05-23T09:00:00.000Z',
            prerelease: true,
            releaseNotes: '## Beta',
            downloads: [
                {
                    kind: 'fullPackage',
                    name: betaAsset.FileName,
                    url: `${productFixture.services.updates.baseUrl.replace(/\/+$/g, '')}/${betaAsset.FileName}`,
                    sizeBytes: 5,
                },
            ],
        };

        try {
            expect(buildUpdateChannels).toBeTypeOf('function');
            await withMockedExistingFeeds(
                {
                    [updateFeedUrl(productFixture, 'stable')]: {
                        Assets: [stableAsset],
                        Latest: stableLatest,
                    },
                    [updateFeedUrl(productFixture, 'beta')]: {
                        Assets: [betaAsset],
                        Latest: betaLatest,
                    },
                },
                async (fetchMock) => {
                    await buildUpdateChannels?.(
                        root,
                        outputRoot,
                        new Date('2026-05-24T00:00:00Z'),
                        { fetchExisting: true }
                    );

                    const stable = JSON.parse(
                        await readFile(
                            channelOutputPath(productFixture, outputRoot, 'stable'),
                            'utf8'
                        )
                    );
                    const beta = JSON.parse(
                        await readFile(
                            channelOutputPath(productFixture, outputRoot, 'beta'),
                            'utf8'
                        )
                    );
                    const nightly = JSON.parse(
                        await readFile(
                            channelOutputPath(productFixture, outputRoot, 'nightly'),
                            'utf8'
                        )
                    );

                    expect(fetchMock).toHaveBeenCalledWith(updateFeedUrl(productFixture, 'stable'));
                    expect(fetchMock).toHaveBeenCalledWith(updateFeedUrl(productFixture, 'beta'));
                    expect(fetchMock).toHaveBeenCalledWith(
                        updateFeedUrl(productFixture, 'nightly')
                    );
                    expect(stable.Assets).toEqual([stableAsset]);
                    expect(stable.Latest).toEqual(stableLatest);
                    expect(beta.Assets).toEqual([betaAsset]);
                    expect(beta.Latest).toEqual(betaLatest);
                    expect(nightly.Assets).toEqual([]);
                    expect(nightly.Latest).toBeNull();
                }
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('keeps existing stable feed while replacing the released beta feed', async () => {
        const buildUpdateChannels = await loadBuilder();
        const productFixture = cloneProductConfig();
        const root = await createFixture(productFixture);
        const outputRoot = join(root, 'dist');
        const releaseDir = join(root, 'release');
        const releaseNotesPath = join(root, 'release-notes.md');
        const stableAsset = {
            PackageId: productFixture.identifier,
            Version: '0.2.0',
            Type: 'Full',
            FileName: 'TouchAI-0.2.0-windows-full.nupkg',
            SHA1: '',
            SHA256: '',
            Size: 4,
        };
        const oldBetaAsset = {
            PackageId: productFixture.identifier,
            Version: '0.2.1-beta.1',
            Type: 'Full',
            FileName: 'TouchAI-0.2.1-beta.1-windows-full.nupkg',
            SHA1: '',
            SHA256: '',
            Size: 5,
        };
        const newBetaFullPackageName = 'TouchAI-beta-0.2.1-beta.2-windows-full.nupkg';
        const newBetaDeltaPackageName = 'TouchAI-beta-0.2.1-beta.2-windows-delta.nupkg';
        const stableLatest: ChannelLatestFixture = {
            version: '0.2.0',
            tag: 'v0.2.0',
            releaseUrl: `${productFixture.repository.releasesUrl}/tag/v0.2.0`,
            publishedAt: '2026-05-22T09:00:00.000Z',
            prerelease: false,
            releaseNotes: '## Stable',
            downloads: [],
        };
        const oldBetaLatest: ChannelLatestFixture = {
            version: '0.2.1-beta.1',
            tag: 'v0.2.1-beta.1',
            releaseUrl: `${productFixture.repository.releasesUrl}/tag/v0.2.1-beta.1`,
            publishedAt: '2026-05-23T09:00:00.000Z',
            prerelease: true,
            releaseNotes: '## Old Beta',
            downloads: [],
        };

        await mkdir(releaseDir, { recursive: true });
        await writeFile(releaseNotesPath, '## Beta 2\n\n- New beta fixes\n', 'utf8');
        await writeFile(join(releaseDir, 'TouchAI-beta-0.2.1-beta.2-windows.msi'), 'installer');
        await writeFile(join(releaseDir, newBetaFullPackageName), 'full');
        await writeFile(join(releaseDir, newBetaDeltaPackageName), 'delta');
        await writeFile(
            join(releaseDir, 'releases.beta.json'),
            JSON.stringify(
                {
                    Assets: [
                        {
                            PackageId: productFixture.identifier,
                            Version: '0.2.1-beta.2',
                            Type: 'Full',
                            FileName: newBetaFullPackageName,
                            SHA1: '',
                            SHA256: '',
                            Size: 4,
                        },
                        {
                            PackageId: productFixture.identifier,
                            Version: '0.2.1-beta.2',
                            Type: 'Delta',
                            FileName: newBetaDeltaPackageName,
                            SHA1: '',
                            SHA256: '',
                            Size: 5,
                        },
                    ],
                },
                null,
                4
            ),
            'utf8'
        );

        try {
            expect(buildUpdateChannels).toBeTypeOf('function');
            await withMockedExistingFeeds(
                {
                    [updateFeedUrl(productFixture, 'stable')]: {
                        Assets: [stableAsset],
                        Latest: stableLatest,
                    },
                    [updateFeedUrl(productFixture, 'beta')]: {
                        Assets: [oldBetaAsset],
                        Latest: oldBetaLatest,
                    },
                },
                async () => {
                    await buildUpdateChannels?.(
                        root,
                        outputRoot,
                        new Date('2026-05-24T00:00:00Z'),
                        {
                            fetchExisting: true,
                            release: {
                                channel: 'beta',
                                version: '0.2.1-beta.2',
                                tag: 'v0.2.1-beta.2',
                                publishedAt: '2026-05-24T16:37:32.103Z',
                                prerelease: true,
                                releaseNotesFile: releaseNotesPath,
                                releaseDir,
                            },
                        }
                    );

                    const stable = JSON.parse(
                        await readFile(
                            channelOutputPath(productFixture, outputRoot, 'stable'),
                            'utf8'
                        )
                    );
                    const beta = JSON.parse(
                        await readFile(
                            channelOutputPath(productFixture, outputRoot, 'beta'),
                            'utf8'
                        )
                    );

                    expect(stable.Assets).toEqual([stableAsset]);
                    expect(stable.Latest).toEqual(stableLatest);
                    expect(beta.Latest.version).toBe('0.2.1-beta.2');
                    expect(beta.Latest.releaseNotes).toBe('## Beta 2\n\n- New beta fixes');
                    expect(
                        beta.Assets.map((asset: { FileName: string }) => asset.FileName)
                    ).toEqual([newBetaFullPackageName, newBetaDeltaPackageName]);
                    expect(beta.Assets).not.toEqual([oldBetaAsset]);
                }
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('copies only current release assets into the update output directory', async () => {
        const buildUpdateChannels = await loadBuilder();
        const productFixture = cloneProductConfig();
        const root = await createFixture(productFixture);
        const outputRoot = join(root, 'dist');
        const releaseDir = join(root, 'release');
        const releaseNotesPath = join(root, 'release-notes.md');
        const copiedNames = [
            'TouchAI-beta-0.2.1-beta.2-windows.msi',
            'TouchAI-beta-0.2.1-beta.2-windows-full.nupkg',
            'TouchAI-beta-0.2.1-beta.2-windows-delta.nupkg',
            'TouchAI-0.2.1-beta.2-linux.AppImage',
        ];
        const ignoredNames = [
            'RELEASES',
            'RELEASES.bak',
            'manifest.json',
            'notes.md',
            'random.txt',
            'TouchAI-beta-0.2.1-beta.1-windows-full.nupkg',
            'TouchAI-beta-0.2.1-beta.1-windows-delta.nupkg',
            'TouchAI-0.2.0-windows-full.nupkg',
        ];

        await mkdir(releaseDir, { recursive: true });
        await writeFile(releaseNotesPath, '## Beta 2\n', 'utf8');
        await writeFile(
            join(releaseDir, 'releases.beta.json'),
            JSON.stringify({ Assets: [] }, null, 4),
            'utf8'
        );

        for (const name of copiedNames) {
            await writeFile(join(releaseDir, name), `asset:${name}`, 'utf8');
        }

        for (const name of ignoredNames) {
            await writeFile(join(releaseDir, name), `ignored:${name}`, 'utf8');
        }

        try {
            expect(buildUpdateChannels).toBeTypeOf('function');
            await buildUpdateChannels?.(root, outputRoot, new Date('2026-05-24T00:00:00Z'), {
                release: {
                    channel: 'beta',
                    version: '0.2.1-beta.2',
                    tag: 'v0.2.1-beta.2',
                    publishedAt: '2026-05-24T16:37:32.103Z',
                    prerelease: true,
                    releaseNotesFile: releaseNotesPath,
                    releaseDir,
                },
            });

            const outputDir = updateOutputDir(productFixture, outputRoot);
            for (const name of copiedNames) {
                await expect(readFile(join(outputDir, name), 'utf8')).resolves.toBe(
                    `asset:${name}`
                );
            }

            for (const name of ignoredNames) {
                await expect(readFile(join(outputDir, name), 'utf8')).rejects.toMatchObject({
                    code: 'ENOENT',
                });
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects non-HTTPS update base URLs', async () => {
        const buildUpdateChannels = await loadBuilder();
        const productFixture = cloneProductConfig();
        const insecureBaseUrl = new URL(productFixture.services.updates.baseUrl);
        insecureBaseUrl.protocol = 'http:';
        const root = await createFixture({
            ...productFixture,
            services: {
                updates: {
                    ...productFixture.services.updates,
                    baseUrl: insecureBaseUrl.toString(),
                },
            },
        });
        const outputRoot = join(root, 'dist');

        try {
            expect(buildUpdateChannels).toBeTypeOf('function');
            await expect(buildUpdateChannels?.(root, outputRoot)).rejects.toThrow(
                'services.updates.baseUrl must use https.'
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('cleans stale files from the output directory', async () => {
        const buildUpdateChannels = await loadBuilder();
        const productFixture = cloneProductConfig();
        const root = await createFixture(productFixture);
        const outputRoot = join(root, 'dist');
        await mkdir(outputRoot, { recursive: true });
        await writeFile(join(outputRoot, 'stale.html'), '<html></html>');

        try {
            expect(buildUpdateChannels).toBeTypeOf('function');
            await buildUpdateChannels?.(root, outputRoot);

            await expect(readFile(join(outputRoot, 'stale.html'), 'utf8')).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
