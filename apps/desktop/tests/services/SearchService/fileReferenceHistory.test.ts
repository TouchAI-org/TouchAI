import type { QuickShortcutItem } from '@services/NativeService';
import { log } from '@services/ObservabilityService';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    FILE_REFERENCE_HISTORY_QUERY,
    loadFileReferenceSuggestions,
    recordAcceptedFileReference,
} from '@/services/SearchService/fileReferenceHistory';

const { findRecentQuickSearchClicksByQueryMock, upsertQuickSearchClickMock } = vi.hoisted(() => ({
    findRecentQuickSearchClicksByQueryMock: vi.fn(),
    upsertQuickSearchClickMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@database/queries/quickSearchClicks', () => ({
    findRecentQuickSearchClicksByQuery: findRecentQuickSearchClicksByQueryMock,
    upsertQuickSearchClick: upsertQuickSearchClickMock,
}));

function createFile(name: string, path: string): QuickShortcutItem {
    return { name, path, source: 'file' };
}

describe('given the user can reference nearby files with @', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findRecentQuickSearchClicksByQueryMock.mockResolvedValue([]);
        upsertQuickSearchClickMock.mockResolvedValue(undefined);
    });

    it('user gets accepted references in recency order with duplicate paths collapsed', async () => {
        const first = createFile('Plan.md', 'D:/Docs/Plan.md');
        const second = createFile('Notes.pdf', 'D:/Docs/Notes.pdf');
        const native = {
            getFileReferenceSuggestions: vi.fn().mockResolvedValue([first, second]),
        };
        findRecentQuickSearchClicksByQueryMock.mockResolvedValue([
            {
                path_norm: 'D:\\Docs\\Plan.md',
                click_count: 8,
                updated_at: '2026-11-09 10:00:03',
            },
            {
                path_norm: 'd:/docs/plan.md',
                click_count: 1,
                updated_at: '2026-11-09 10:00:02',
            },
            {
                path_norm: 'D:\\Docs\\Notes.pdf',
                click_count: 2,
                updated_at: '2026-11-09 10:00:01',
            },
        ]);

        await expect(
            loadFileReferenceSuggestions(native, 12, new AbortController().signal)
        ).resolves.toEqual([first, second]);

        expect(findRecentQuickSearchClicksByQueryMock).toHaveBeenCalledWith({
            queryNorm: FILE_REFERENCE_HISTORY_QUERY,
            limit: 40,
        });
        expect(native.getFileReferenceSuggestions).toHaveBeenCalledWith(
            ['D:\\Docs\\Plan.md', 'D:\\Docs\\Notes.pdf'],
            12,
            expect.any(AbortSignal)
        );
    });

    it('user given no accepted references gets recently modified document fallback candidates', async () => {
        const document = createFile('Recent.docx', 'D:/Docs/Recent.docx');
        const native = {
            getFileReferenceSuggestions: vi.fn().mockResolvedValue([document]),
        };

        await expect(
            loadFileReferenceSuggestions(native, 12, new AbortController().signal)
        ).resolves.toEqual([document]);

        expect(native.getFileReferenceSuggestions).toHaveBeenCalledWith(
            [],
            12,
            expect.any(AbortSignal)
        );
    });

    it('user still gets document fallback candidates when reference history cannot be read', async () => {
        const document = createFile('Recent.md', 'D:/Docs/Recent.md');
        const native = {
            getFileReferenceSuggestions: vi.fn().mockResolvedValue([document]),
        };
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
        findRecentQuickSearchClicksByQueryMock.mockRejectedValue(new Error('sqlite unavailable'));

        await expect(
            loadFileReferenceSuggestions(native, 12, new AbortController().signal)
        ).resolves.toEqual([document]);
        expect(native.getFileReferenceSuggestions).toHaveBeenCalledWith(
            [],
            12,
            expect.any(AbortSignal)
        );
        expect(warn).toHaveBeenCalled();
    });

    it('user gets no picker suggestions after the query was cancelled', async () => {
        const controller = new AbortController();
        const native = {
            getFileReferenceSuggestions: vi.fn(),
        };
        controller.abort();

        await expect(loadFileReferenceSuggestions(native, 12, controller.signal)).resolves.toEqual(
            []
        );

        expect(findRecentQuickSearchClicksByQueryMock).not.toHaveBeenCalled();
        expect(native.getFileReferenceSuggestions).not.toHaveBeenCalled();
    });

    it('user gets one durable history entry only after a reference is accepted', async () => {
        recordAcceptedFileReference('D:/Docs/Plan.md');

        expect(upsertQuickSearchClickMock).toHaveBeenCalledWith({
            queryNorm: FILE_REFERENCE_HISTORY_QUERY,
            pathNorm: 'D:\\Docs\\Plan.md',
            maxClickCount: 1_000_000,
        });
    });
});
