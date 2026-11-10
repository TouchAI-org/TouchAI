import { describe, expect, it, vi } from 'vitest';

import { SearchProviderRegistry } from '@/services/SearchService';
import { createFileSearchProvider, fileSearchItem } from '@/services/SearchService/files';

describe('given the native file index contributes to shared search', () => {
    it('user gets distinct open and reference actions without reading file contents', async () => {
        const file = { name: 'notes.md', path: 'D:/notes.md', source: 'file' as const };
        const registry = new SearchProviderRegistry();
        registry.registerProvider(
            createFileSearchProvider({
                async searchShortcuts() {
                    return {
                        shortcuts: [],
                        files: [file],
                        total_files: 1,
                        total_results: 1,
                        next_offset: 1,
                    };
                },
            })
        );
        const session = registry.createSession();
        await session.search({ query: 'notes', intent: 'launcher' });
        const result = session.snapshot.items[0]!.result;
        expect(fileSearchItem(result)).toEqual(file);
        expect(result.primaryAction).toEqual({ kind: 'file.open', path: file.path });
        expect(result.completionAction).toEqual({ kind: 'file.reference', item: file });
        await session.search({ query: 'notes', intent: 'file-reference' });
        expect(session.snapshot.items[0]!.result.primaryAction).toEqual(result.completionAction);
    });

    it('user receives later file pages without repeating shortcut rows', async () => {
        const registry = new SearchProviderRegistry();
        registry.registerProvider(
            createFileSearchProvider({
                async searchShortcuts(_query, _limit, offset) {
                    return {
                        shortcuts: [{ name: 'App', path: 'app.lnk', source: 'desktop_user' }],
                        files: [{ name: `file-${offset}`, path: `file-${offset}`, source: 'file' }],
                        total_files: 2,
                        total_results: 3,
                        next_offset: offset! + 1,
                    };
                },
            })
        );
        const session = registry.createSession();
        await session.search({ query: 'file', intent: 'launcher' });
        await session.loadMore();
        expect(session.snapshot.items.map(({ result }) => result.label)).toEqual([
            'App',
            'file-0',
            'file-1',
        ]);
        expect(session.snapshot.providers[0]?.nextCursor).toBeUndefined();
    });

    it('user given a bare @ gets reference suggestions without running an empty native search', async () => {
        const recent = { name: 'notes.md', path: 'D:/notes.md', source: 'file' as const };
        const searchShortcuts = vi.fn();
        const loadSuggestions = vi.fn().mockResolvedValue([recent]);
        const registry = new SearchProviderRegistry();
        registry.registerProvider(
            createFileSearchProvider(
                {
                    searchShortcuts,
                },
                {
                    loadReferenceSuggestions: loadSuggestions,
                }
            )
        );
        const session = registry.createSession();

        await session.search({ query: '', intent: 'file-reference' });

        expect(loadSuggestions).toHaveBeenCalledWith(12, expect.any(AbortSignal));
        expect(searchShortcuts).not.toHaveBeenCalled();
        expect(session.snapshot.items.map(({ result }) => result.label)).toEqual(['notes.md']);
        expect(session.snapshot.items[0]?.result.primaryAction).toEqual({
            kind: 'file.reference',
            item: recent,
        });
    });

    it('user gets an empty reference picker when no recent or fallback suggestions exist', async () => {
        const searchShortcuts = vi.fn();
        const registry = new SearchProviderRegistry();
        registry.registerProvider(
            createFileSearchProvider(
                { searchShortcuts },
                {
                    loadReferenceSuggestions: vi.fn().mockResolvedValue([]),
                }
            )
        );
        const session = registry.createSession();

        await session.search({ query: '  ', intent: 'file-reference' });

        expect(session.snapshot.items).toEqual([]);
        expect(session.snapshot.providers[0]?.total).toBe(0);
        expect(searchShortcuts).not.toHaveBeenCalled();
    });

    it('user never treats a non-file contribution as a native path', () => {
        expect(
            fileSearchItem({ id: 'app', kind: 'miniapp', group: 'miniapp', label: 'App' })
        ).toBeNull();
    });
});
