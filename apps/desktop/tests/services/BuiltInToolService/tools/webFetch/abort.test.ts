import { describe, expect, it, vi } from 'vitest';

import { extractHtmlContent } from '@/services/BuiltInToolService/tools/webFetch/helper';

describe('extractHtmlContent cancellation', () => {
    it('stays synchronous and side-effect free so callers can guard cancellation', () => {
        const request = {
            url: new URL('https://example.com/article'),
            mode: 'page_text',
            maxChars: 2000,
            timeoutMs: 20000,
            maxResponseBytes: 1024 * 1024,
        } as unknown as Parameters<typeof extractHtmlContent>[1];

        // 解析本身不接收 signal；取消语义由调用方在解析前后检查，
        // 这里锁定「解析不自行发起异步任务」这一前提。
        const result = extractHtmlContent('<article><p>body</p></article>', request);

        expect(result.content).toContain('body');
        expect(result.actualMode).toBe('page_text');
    });
});

describe('web fetch abort guard', () => {
    it('returns an aborted request without parsing when the signal is already aborted', async () => {
        const { executeWebFetchTool } =
            await import('@/services/BuiltInToolService/tools/webFetch');
        const { interceptTauriInvoke } = await import('@tests/utils/tauri');
        interceptTauriInvoke(() => undefined);

        const controller = new AbortController();
        controller.abort();

        const result = await executeWebFetchTool(
            { url: 'https://example.com/article', mode: 'page_text', maxChars: 2000 },
            {} as Record<string, never>,
            { signal: controller.signal } as never
        );

        expect(result.isError).toBe(true);
        void vi;
    }, 30_000);
});
