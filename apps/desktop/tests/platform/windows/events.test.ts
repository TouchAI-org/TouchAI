import { describe, expect, it } from 'vitest';

import { createWindowEvent } from '@/platform/windows/events';

describe('given independently created window event capabilities', () => {
    it('user given an active subscription when publishing and then unsubscribing receives only the earlier payload', async () => {
        const publisher = createWindowEvent<{ revision: number }>('settings:revision');
        const subscriber = createWindowEvent<{ revision: number }>('settings:revision');
        const received: { revision: number }[] = [];
        const stop = await subscriber.on((payload) => received.push(payload));

        await publisher.emit({ revision: 1 });
        stop();
        await publisher.emit({ revision: 2 });

        expect(received).toEqual([{ revision: 1 }]);
    });
});
