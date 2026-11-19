import { describe, expect, it } from 'vitest';

import { initializeSearchWindow } from '@/app/bootstrap/search';

describe('given a production search window lifetime', () => {
    it('user given two search surfaces when closing one then can continue querying the other', async () => {
        const window = initializeSearchWindow('main');
        const first = window.api!.openFileSession();
        const second = window.api!.openFileSession();
        first.dispose();

        await expect(second.search({ query: 'report', intent: 'launcher' })).resolves.toMatchObject(
            {
                query: 'report',
                stale: false,
            }
        );
        window.dispose();
        await expect(second.search({ query: 'later', intent: 'launcher' })).rejects.toThrow();
    });

    it.each(['settings', 'tray-menu', 'computer-use-glow', null])(
        'user given a secondary window %s when requesting search then has no local host',
        (label) => {
            const window = initializeSearchWindow(label);
            expect(window.api).toBeUndefined();
            window.dispose();
        }
    );
});
