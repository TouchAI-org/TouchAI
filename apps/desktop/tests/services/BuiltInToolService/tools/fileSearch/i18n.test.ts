import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';

const { nativeMock } = vi.hoisted(() => ({
    nativeMock: {
        quickSearch: {
            getStatus: vi.fn(),
            searchFiles: vi.fn(),
        },
    },
}));

vi.mock('@services/NativeService', () => ({
    native: nativeMock,
}));

describe('FileSearch i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
    });

    it('formats successful file search payload in the active locale', async () => {
        setLocale('en-US');
        nativeMock.quickSearch.searchFiles.mockResolvedValue([
            {
                name: '设置.md',
                path: 'E:/docs/设置.md',
            },
        ]);

        const { executeFileSearchTool } = await import(
            '@/services/BuiltInToolService/tools/fileSearch'
        );
        const result = await executeFileSearchTool(
            { includeShortcutFiles: false, query: '设置', limit: 5 },
            {},
            {
                callId: 'call-1',
                hasExecutedBuiltInTool: () => false,
                iteration: 1,
            }
        );

        expect(result.result).toContain('Local file search');
        expect(result.result).toContain('Original query: 设置');
        expect(result.result).toContain('Everything query: 设置');
        expect(result.result).toContain('Returned: 1 / 5');
        expect(result.result).toContain('Path: E:/docs/设置.md');
        expect(result.result).not.toContain('本机文件搜索');
        expect(result.result).not.toContain('路径:');
    });

    it('formats empty and error file search payloads in the active locale', async () => {
        setLocale('en-US');

        const { executeFileSearchTool } = await import(
            '@/services/BuiltInToolService/tools/fileSearch'
        );

        nativeMock.quickSearch.searchFiles.mockResolvedValueOnce([]);
        const emptyResult = await executeFileSearchTool(
            { includeShortcutFiles: false, query: 'missing', limit: 3 },
            {},
            {
                callId: 'call-1',
                hasExecutedBuiltInTool: () => false,
                iteration: 1,
            }
        );

        expect(emptyResult.result).toContain('No matching files found.');
        expect(emptyResult.result).not.toContain('未找到匹配的文件');

        nativeMock.quickSearch.searchFiles.mockRejectedValueOnce(new Error('backend unavailable'));
        nativeMock.quickSearch.getStatus.mockResolvedValueOnce({
            db_loaded: false,
            index_warmed: false,
            last_error: 'Everything service unavailable',
            last_refresh_ms: null,
            provider: 'unavailable',
        });
        const errorResult = await executeFileSearchTool(
            { includeShortcutFiles: false, query: 'missing', limit: 3 },
            {},
            {
                callId: 'call-2',
                hasExecutedBuiltInTool: () => false,
                iteration: 1,
            }
        );

        expect(errorResult.result).toContain('Local file search failed');
        expect(errorResult.result).toContain('Reason: Everything service unavailable');
        expect(errorResult.result).not.toContain('本机文件搜索失败');
        expect(errorResult.result).not.toContain('原因:');
    });

    it('localizes the default conversation semantic target', async () => {
        setLocale('en-US');

        const { fileSearchTool } = await import('@/services/BuiltInToolService/tools/fileSearch');

        expect(fileSearchTool.buildConversationSemantic({ query: '*' })).toEqual({
            action: 'search',
            target: 'local files',
        });
    });
});
