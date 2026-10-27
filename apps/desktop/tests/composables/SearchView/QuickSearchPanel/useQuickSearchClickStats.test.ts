import type { QuickShortcutItem } from '@services/NativeService';
import { log } from '@services/ObservabilityService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useQuickSearchClickStats } from '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchClickStats';

const { findQuickSearchClicksByQueryMock, upsertQuickSearchClickMock } = vi.hoisted(() => ({
    findQuickSearchClicksByQueryMock: vi.fn(),
    upsertQuickSearchClickMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@database/queries/quickSearchClicks', () => ({
    findQuickSearchClicksByQuery: findQuickSearchClicksByQueryMock,
    upsertQuickSearchClick: upsertQuickSearchClickMock,
}));

function createShortcut(name: string, path: string): QuickShortcutItem {
    return {
        name,
        path,
        source: 'desktop_user',
    };
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('when the quick search panel ranks results by what the user clicks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findQuickSearchClicksByQueryMock.mockResolvedValue([]);
        upsertQuickSearchClickMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the most clicked results first while equally clicked ones keep their order', async () => {
        const stats = useQuickSearchClickStats();
        const alpha = createShortcut('Alpha', 'D:/Alpha.lnk');
        const beta = createShortcut('Beta', 'D:/Beta.lnk');
        const gamma = createShortcut('Gamma', 'D:/Gamma.lnk');

        findQuickSearchClicksByQueryMock.mockResolvedValue([
            { path_norm: 'd:\\beta.lnk', click_count: 7 },
            { path_norm: 'd:\\alpha.lnk', click_count: 7 },
            { path_norm: 'd:\\gamma.lnk', click_count: 1 },
        ]);

        const firstRank = await stats.rankResults('  Touch   AI  ', [alpha, beta, gamma]);
        const secondRank = await stats.rankResults('touch ai', [alpha, beta, gamma]);

        expect(findQuickSearchClicksByQueryMock).toHaveBeenCalledTimes(1);
        expect(findQuickSearchClicksByQueryMock).toHaveBeenCalledWith({
            queryNorm: 'touch ai',
            limit: 200,
        });
        expect(firstRank).toEqual([alpha, beta, gamma]);
        expect(secondRank).toEqual([alpha, beta, gamma]);
    });

    it('user gets the click remembered for the next search', async () => {
        const stats = useQuickSearchClickStats();
        const foo = createShortcut('Foo', 'D:/Tools/Foo.lnk');
        const bar = createShortcut('Bar', 'D:/Tools/Bar.lnk');

        stats.recordClick('  Touch   AI  ', 'D:/Tools/Foo.lnk');
        await flushAsyncWork();

        const ranked = await stats.rankResults('touch ai', [bar, foo]);

        expect(findQuickSearchClicksByQueryMock).not.toHaveBeenCalled();
        expect(upsertQuickSearchClickMock).toHaveBeenCalledWith({
            queryNorm: 'touch ai',
            pathNorm: 'd:\\tools\\foo.lnk',
            maxClickCount: 1_000_000,
        });
        expect(ranked).toEqual([foo, bar]);
    });

    it('user still sees results in their original order when click history cannot be read', async () => {
        const stats = useQuickSearchClickStats();
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
        const alpha = createShortcut('Alpha', 'D:/Alpha.lnk');
        const beta = createShortcut('Beta', 'D:/Beta.lnk');

        findQuickSearchClicksByQueryMock.mockRejectedValue(new Error('sqlite unavailable'));

        await expect(stats.rankResults('alpha', [alpha, beta])).resolves.toEqual([alpha, beta]);
        expect(warnSpy).toHaveBeenCalled();
    });
});
