import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findQuickSearchClicksMock } = vi.hoisted(() => ({
    findQuickSearchClicksMock: vi.fn(),
}));

vi.mock('@database/queries/quickSearchClicks', () => ({
    findQuickSearchClicksByQuery: findQuickSearchClicksMock,
    upsertQuickSearchClick: vi.fn(),
}));

import { useQuickSearchClickStats } from '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchClickStats';

function item(name: string, path: string) {
    return { name, path, source: 'desktop_user' as const };
}

describe('useQuickSearchClickStats prefetch', () => {
    beforeEach(() => {
        findQuickSearchClicksMock.mockReset();
    });

    it('loads click stats once when prefetching and reuses them when ranking', async () => {
        findQuickSearchClicksMock.mockResolvedValue([{ path_norm: 'd:\\a.lnk', click_count: 3 }]);
        const stats = useQuickSearchClickStats();

        await stats.prefetch('Touch AI');

        expect(findQuickSearchClicksMock).toHaveBeenCalledTimes(1);
        const ranked = await stats.rankResults('Touch AI', [
            item('B', 'D:/B.lnk'),
            item('A', 'D:/A.lnk'),
        ]);
        expect(findQuickSearchClicksMock).toHaveBeenCalledTimes(1);
        expect(ranked.map((entry) => entry.name)).toEqual(['A', 'B']);
    });

    it('still lazily loads stats when rankResults is called without prefetch', async () => {
        findQuickSearchClicksMock.mockResolvedValue([]);
        const stats = useQuickSearchClickStats();

        await stats.rankResults('Other Query', [item('A', 'D:/A.lnk')]);

        expect(findQuickSearchClicksMock).toHaveBeenCalledTimes(1);
    });

    it('does not reject when the prefetch read fails', async () => {
        findQuickSearchClicksMock.mockRejectedValue(new Error('db down'));
        const stats = useQuickSearchClickStats();

        await expect(stats.prefetch('Broken')).resolves.toBeUndefined();

        const ranked = await stats.rankResults('Broken', [item('A', 'D:/A.lnk')]);
        expect(ranked.map((entry) => entry.name)).toEqual(['A']);
        expect(findQuickSearchClicksMock).toHaveBeenCalledTimes(1);
    });
});
