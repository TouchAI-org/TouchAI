import { describe, expect, it, vi } from 'vitest';

import { createClient, resolveBotLogin } from '../../../.github/ui-preview/lib/github.mjs';
import { selectUiDiff } from '../../../.github/ui-preview/lib/model.mjs';

describe('user previews a pull request beyond the aggregate diff limit', () => {
    it('user gets UI patches from every page when the combined diff endpoint rejects the PR', async () => {
        const firstPage = Array.from({ length: 100 }, (_, index) => ({
            filename: `docs/change-${index}.md`,
            patch: '@@ -1 +1 @@\n-old\n+new',
        }));
        const lastPage = [
            {
                filename: 'apps/desktop/src/views/SearchView/index.vue',
                patch: '@@ -1 +1 @@\n-old window\n+stable window',
            },
            { filename: 'apps/desktop/src/assets/preview.png' },
        ];
        vi.stubGlobal('fetch', async (url) => {
            if (url.endsWith('/files?per_page=100&page=1')) {
                return new Response(JSON.stringify(firstPage));
            }
            if (url.endsWith('/files?per_page=100&page=2')) {
                return new Response(JSON.stringify(lastPage));
            }
            return new Response(
                JSON.stringify({
                    message: 'Sorry, the diff exceeded the maximum number of lines (20000)',
                }),
                { status: 406 }
            );
        });

        try {
            const client = createClient({
                token: 'test-token',
                owner: 'TouchAI-org',
                repo: 'TouchAI',
            });
            const diff = selectUiDiff(await client.getDiff(753));
            expect(diff.text).toContain('+stable window');
            expect(diff.text).not.toContain('docs/change-');
            expect(diff.dropped).toHaveLength(100);
            expect(diff.text).toContain('Patch unavailable');
            expect(diff.files).toContain('apps/desktop/src/assets/preview.png');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('user sees the API failure when reading a file page fails', async () => {
        vi.stubGlobal('fetch', async () => new Response('Forbidden', { status: 403 }));
        try {
            const client = createClient({
                token: 'test-token',
                owner: 'TouchAI-org',
                repo: 'TouchAI',
            });
            await expect(client.getDiff(753)).rejects.toMatchObject({ status: 403 });
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('user resolves the preview bot identity', () => {
    it('user gets the workflow App slug without calling GET /user', async () => {
        const client = {
            getAuthenticatedUser: vi.fn(),
        };

        await expect(resolveBotLogin(client, 'touchai-ui-preview[bot]')).resolves.toBe(
            'touchai-ui-preview[bot]'
        );
        expect(client.getAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('user gets the local token identity when no App slug is configured', async () => {
        const client = {
            getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'local-user' }),
        };

        await expect(resolveBotLogin(client, '')).resolves.toBe('local-user');
        expect(client.getAuthenticatedUser).toHaveBeenCalledOnce();
    });
});

describe('user removes an unauthorized approval label', () => {
    it('user gets the label removed from the pull request', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response('[]', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        );
        vi.stubGlobal('fetch', fetchMock);

        try {
            const client = createClient({
                token: 'test-token',
                owner: 'TouchAI-org',
                repo: 'TouchAI',
            });

            await client.removeLabel(12, 'status:ui-preview-approved');

            expect(fetchMock).toHaveBeenCalledWith(
                'https://api.github.com/repos/TouchAI-org/TouchAI/issues/12/labels/status%3Aui-preview-approved',
                expect.objectContaining({ method: 'DELETE' })
            );
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
