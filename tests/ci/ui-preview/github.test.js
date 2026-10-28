import { describe, expect, it, vi } from 'vitest';

import { createClient, resolveBotLogin } from '../../../.github/ui-preview/lib/github.mjs';

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
