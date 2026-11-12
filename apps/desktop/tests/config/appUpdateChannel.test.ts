import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadInstalledProduct(version: string) {
    vi.doMock('../../package.json', () => ({ default: { version } }));
    return import('@/config/product');
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.doUnmock('../../package.json');
});

describe('given a fresh installation with no saved update channel', () => {
    it.each([
        { version: '1.2.2', channel: 'stable' },
        { version: '1.3.0-beta.2', channel: 'beta' },
        { version: '1.2.3-nightly.20261108.206.1', channel: 'nightly' },
        { version: '1.3.0-beta.2+build.123', channel: 'beta' },
    ])('user follows $channel when starting version $version', async ({ version, channel }) => {
        const product = await loadInstalledProduct(version);

        expect(product.DEFAULT_APP_UPDATE_CHANNEL).toBe(channel);
        expect(product.normalizeAppUpdateChannel(null)).toBe(channel);
    });

    it.each(['1.3.0-rc.1', '1.3.0-beta-preview.1', '1.3.0+build-beta.2', 'invalid'])(
        'user falls back to Stable when starting an unrecognized release %s',
        async (version) => {
            const product = await loadInstalledProduct(version);

            expect(product.DEFAULT_APP_UPDATE_CHANNEL).toBe('stable');
        }
    );
});

describe('given a prerelease installation with an explicit update preference', () => {
    it.each(['stable', 'beta', 'nightly'])(
        'user keeps the saved %s preference when starting a Beta build',
        async (channel) => {
            const product = await loadInstalledProduct('1.3.0-beta.2');

            expect(product.normalizeAppUpdateChannel(channel)).toBe(channel);
        }
    );
});
