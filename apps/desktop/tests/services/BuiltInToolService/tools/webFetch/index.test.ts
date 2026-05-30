import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { executeWebFetchTool } from '@/services/BuiltInToolService/tools/webFetch';

const { tauriFetchMock } = vi.hoisted(() => ({
    tauriFetchMock: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/providers', () => ({
    createTauriFetch: () => tauriFetchMock,
}));

describe('executeWebFetchTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('en-US');
    });

    it('rejects redirects to private network hosts before following them', async () => {
        tauriFetchMock.mockResolvedValueOnce(
            new Response('', {
                status: 302,
                headers: {
                    location: 'http://127.0.0.1/admin',
                },
            })
        );

        const result = await executeWebFetchTool(
            { url: 'https://example.test/redirect', mode: 'page_text', maxChars: 1000 },
            {},
            createExecutionContext()
        );

        expect(result).toMatchObject({
            isError: true,
            status: 'error',
            errorMessage:
                'WebFetch tool blocks localhost, private-network and single-label hostnames.',
        });
        expect(tauriFetchMock).toHaveBeenCalledTimes(1);
        expect(tauriFetchMock).toHaveBeenCalledWith(
            'https://example.test/redirect',
            expect.objectContaining({
                maxRedirections: 0,
                redirect: 'manual',
            })
        );
    });

    it('follows safe same-origin redirects and reports the final URL', async () => {
        tauriFetchMock
            .mockResolvedValueOnce(
                new Response('', {
                    status: 301,
                    headers: {
                        location: '/final',
                    },
                })
            )
            .mockResolvedValueOnce(
                new Response('redirected content', {
                    status: 200,
                    headers: {
                        'content-type': 'text/plain',
                    },
                })
            );

        const result = await executeWebFetchTool(
            { url: 'https://example.test/start', mode: 'page_text', maxChars: 1000 },
            {},
            createExecutionContext()
        );

        expect(result).toMatchObject({
            isError: false,
            status: 'success',
        });
        expect(result.result).toContain('Request URL: https://example.test/start');
        expect(result.result).toContain('Final URL: https://example.test/final');
        expect(result.result).toContain('redirected content');
        expect(tauriFetchMock).toHaveBeenNthCalledWith(
            2,
            'https://example.test/final',
            expect.objectContaining({
                maxRedirections: 0,
                redirect: 'manual',
            })
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
