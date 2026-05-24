import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
    kind: 'installer' | 'portable' | 'fullPackage' | 'deltaPackage' | 'asset';
    name: string;
    url: string;
    sizeBytes: number | null;
};
type BuildUpdateChannels = (
    projectRoot: string,
    outputRoot: string,
    now?: Date,
    options?: {
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
                projectName: string;
                branch: string;
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
    return join(
        outputRoot,
        ...updatePathSegments(product.services.updates.baseUrl),
        'channels',
        `${channel}.json`
    );
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
                schemaVersion: 1,
                product: productFixture.product,
                displayName: productFixture.displayName,
                channel: 'stable',
                generatedAt: '2026-05-24T00:00:00.000Z',
                latest: null,
                policy: {
                    minimumSupportedVersion: '0.2.1',
                    requiredSeverity: 'critical',
                    requiredReason: 'Security update required',
                },
            });
            expect(beta.policy.minimumSupportedVersion).toBeNull();
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

            expect(stable.product).toBe(derivedProductName);
            expect(stable.channel).toBe('stable');
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
        const installerName = 'TouchAI-beta-0.1.1-beta.1-Setup.exe';
        const portableName = 'TouchAI-beta-0.1.1-beta.1-Portable.zip';
        await mkdir(releaseDir, { recursive: true });
        await writeFile(releaseNotesPath, '## Changes\n\n- Beta fixes\n', 'utf8');
        await writeFile(join(releaseDir, installerName), 'installer');
        await writeFile(join(releaseDir, portableName), 'portable');

        try {
            expect(buildUpdateChannels).toBeTypeOf('function');
            await buildUpdateChannels?.(root, outputRoot, new Date('2026-05-24T00:00:00Z'), {
                release: {
                    channel: 'beta',
                    version: '0.1.1-beta.1',
                    tag: 'v0.1.1-beta.1',
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

            expect(beta.latest).toEqual({
                version: '0.1.1-beta.1',
                tag: 'v0.1.1-beta.1',
                releaseUrl: 'https://github.com/TouchAI-org/TouchAI/releases/tag/v0.1.1-beta.1',
                publishedAt: '2026-05-24T16:37:32.103Z',
                prerelease: true,
                releaseNotes: '## Changes\n\n- Beta fixes',
                downloads: [
                    {
                        kind: 'installer',
                        name: installerName,
                        url: `https://github.com/TouchAI-org/TouchAI/releases/download/v0.1.1-beta.1/${installerName}`,
                        sizeBytes: 9,
                    },
                    {
                        kind: 'portable',
                        name: portableName,
                        url: `https://github.com/TouchAI-org/TouchAI/releases/download/v0.1.1-beta.1/${portableName}`,
                        sizeBytes: 8,
                    },
                ],
            });
            expect(stable.latest).toBeNull();
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
