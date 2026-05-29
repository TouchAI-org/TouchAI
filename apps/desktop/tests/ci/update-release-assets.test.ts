import { describe, expect, it } from 'vitest';

import {
    channelFromAssetName,
    channelFromTag,
    channelFromVersion,
    deriveReleaseTagFromAssetName,
    githubRepositoryFromProduct,
    relativeUpdatePath,
} from '../../scripts/update-release-assets.mjs';

describe('update release asset helpers', () => {
    it('derives release tags and channels from normalized update asset names', () => {
        expect(deriveReleaseTagFromAssetName('TouchAI-beta-0.2.0-beta.4-windows-full.nupkg')).toBe(
            'v0.2.0-beta.4'
        );
        expect(deriveReleaseTagFromAssetName('TouchAI-nightly-latest-windows.msi')).toBeNull();
        expect(channelFromAssetName('TouchAI-0.2.0-windows.msi')).toBe('stable');
        expect(channelFromAssetName('TouchAI-beta-0.2.0-beta.4-macos.dmg')).toBe('beta');
        expect(channelFromTag('v0.3.0-nightly.20260529.1')).toBe('nightly');
        expect(channelFromVersion('1.2.3-beta')).toBe('beta');
        expect(channelFromVersion('1.2.3-nightly')).toBe('nightly');
    });

    it('derives update base path and GitHub repository from product config', () => {
        const product = {
            repository: {
                url: 'https://github.com/TouchAI-org/TouchAI',
            },
        };

        expect(relativeUpdatePath('https://updates.touch-ai.org/touchai-app/v1')).toBe(
            'touchai-app/v1'
        );
        expect(githubRepositoryFromProduct(product)).toBe('TouchAI-org/TouchAI');
        expect(
            githubRepositoryFromProduct({
                repository: {
                    url: 'https://github.com/TouchAI-org/TouchAI.git',
                },
            })
        ).toBe('TouchAI-org/TouchAI');
    });
});
