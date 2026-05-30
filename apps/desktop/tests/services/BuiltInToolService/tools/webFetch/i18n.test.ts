import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { executeWebFetchTool, webFetchTool } from '@/services/BuiltInToolService/tools/webFetch';
import {
    buildPageMarkdown,
    createRequestSignal,
    formatFetchResult,
    formatUnsupportedResponse,
    parseWebFetchRequest,
    truncateContent,
} from '@/services/BuiltInToolService/tools/webFetch/helper';

const { tauriFetchMock } = vi.hoisted(() => ({
    tauriFetchMock: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/providers', () => ({
    createTauriFetch: () => tauriFetchMock,
}));

describe('WebFetch tool i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        setLocale('zh-CN');
    });

    it('localizes generated fetch report labels in English mode while preserving page content', () => {
        setLocale('en-US');
        const request = {
            url: new URL('https://example.test/article'),
            mode: 'reader',
            maxChars: 4000,
            timeoutMs: 20000,
        } as Parameters<typeof formatFetchResult>[0];
        const response = new Response('', {
            status: 200,
            statusText: 'OK',
        });
        Object.defineProperty(response, 'url', {
            value: 'https://example.test/final',
        });

        const result = formatFetchResult(request, response, 'text/html', {
            content: '页面正文保留原文',
            actualMode: 'reader',
            bodyTruncated: true,
            sourceTruncated: true,
            title: '页面标题保留原文',
            byline: '作者保留原文',
            siteName: '站点名保留原文',
            publishedTime: '2026-05-22',
            excerpt: '摘要内容保留原文',
        });

        expect(result).toContain('Web page fetch');
        expect(result).toContain('Request URL: https://example.test/article');
        expect(result).toContain('Final URL: https://example.test/final');
        expect(result).toContain('HTTP status: 200 OK');
        expect(result).toContain('Title: 页面标题保留原文');
        expect(result).toContain(
            'Source content: truncated at 1500000 characters before conversion'
        );
        expect(result).toContain('Body output: limited to 4000 characters');
        expect(result).toContain('页面正文保留原文');
        expect(result).not.toContain('网页抓取');
        expect(result).not.toContain('请求 URL');
    });

    it('localizes unsupported response labels and reasons', () => {
        setLocale('en-US');
        const request = {
            url: new URL('https://example.test/file.zip'),
            mode: 'reader',
            maxChars: 4000,
            timeoutMs: 20000,
        } as Parameters<typeof formatUnsupportedResponse>[0];
        const response = new Response('', {
            status: 415,
            statusText: 'Unsupported Media Type',
        });

        const result = formatUnsupportedResponse(request, response, 'application/zip');

        expect(result).toContain('Web page fetch failed');
        expect(result).toContain(
            'Reason: Only HTML, JSON, Markdown, XML, and plain text responses are supported.'
        );
        expect(result).not.toContain('网页抓取失败');
        expect(result).not.toContain('原因: 当前仅支持');
    });

    it('localizes truncation fallback text', () => {
        setLocale('en-US');

        const result = truncateContent('abcdef', 3);

        expect(result.content).toBe('abc\n\n[Body truncated, 6 characters total]');
    });

    it('localizes request validation errors in English', () => {
        setLocale('en-US');

        expect(() =>
            parseWebFetchRequest({ url: 'not a url', mode: 'reader', maxChars: 1000 })
        ).toThrow('WebFetch tool received an invalid URL: not a url');
        expect(() =>
            parseWebFetchRequest({ url: 'ftp://example.test/file', mode: 'reader', maxChars: 1000 })
        ).toThrow('WebFetch tool only supports http:// and https:// URLs.');
        expect(() =>
            parseWebFetchRequest({
                url: 'https://user:pass@example.test',
                mode: 'reader',
                maxChars: 1000,
            })
        ).toThrow('WebFetch tool does not allow embedded credentials in URLs.');
        expect(() =>
            parseWebFetchRequest({ url: 'https://localhost', mode: 'reader', maxChars: 1000 })
        ).toThrow('WebFetch tool blocks localhost, private-network and single-label hostnames.');
    });

    it('localizes timeout abort reason in English', () => {
        setLocale('en-US');
        vi.useFakeTimers();

        const { signal, cleanup } = createRequestSignal(undefined, 1000);
        vi.advanceTimersByTime(1000);

        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBeInstanceOf(DOMException);
        expect((signal.reason as DOMException).message).toBe('WebFetch timed out after 1000ms');
        cleanup();
    });

    it('localizes unsupported content type error message in English', async () => {
        setLocale('en-US');
        tauriFetchMock.mockResolvedValueOnce(
            new Response('', {
                status: 200,
                headers: {
                    'content-type': 'application/zip',
                },
            })
        );

        const result = await executeWebFetchTool(
            { url: 'https://example.test/file.zip', mode: 'reader', maxChars: 1000 },
            {},
            createExecutionContext()
        );

        expect(result).toMatchObject({
            isError: true,
            status: 'error',
            errorMessage: 'Unsupported content type: application/zip',
        });
        expect(result.result).toContain('Web page fetch failed');
    });

    it('localizes fallback target and image alt text in English', () => {
        setLocale('en-US');

        expect(webFetchTool.buildConversationSemantic({})).toMatchObject({
            action: 'read',
            target: 'web page',
        });
        expect(buildPageMarkdown('<main><img alt="示意图"></main>', 'https://example.test')).toBe(
            '[Image: 示意图]'
        );
    });
});

function createExecutionContext(): Parameters<typeof executeWebFetchTool>[2] {
    return {
        signal: new AbortController().signal,
        callId: 'web-fetch-call',
        iteration: 1,
        hasExecutedBuiltInTool: vi.fn(() => false),
    };
}
