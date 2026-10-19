import { describe, expect, it, vi } from 'vitest';

import { createSectionPreloader } from '@/views/SettingsView/sectionPreloader';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe('createSectionPreloader', () => {
    it('loads each section once and deduplicates repeats', async () => {
        const load = vi.fn(async () => undefined);
        const preloader = createSectionPreloader({ load, schedule: (run) => run() });

        preloader.prefetch('general');
        preloader.prefetch('general');
        await Promise.resolve();
        await Promise.resolve();

        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledWith('general');
        expect(preloader.isLoaded('general')).toBe(true);
    });

    it('serializes loads and lets hover prefetch jump the queue', async () => {
        const first = deferred();
        const load = vi.fn(async (section: string) => {
            if (section === 'slow') {
                await first.promise;
            }
        });
        const preloader = createSectionPreloader({ load, schedule: (run) => run() });

        preloader.prefetch('slow');
        preloader.prefetch('queued');
        preloader.prefetch('hovered', { priority: true });

        await Promise.resolve();
        await Promise.resolve();
        expect(load).toHaveBeenCalledWith('slow');
        expect(load).not.toHaveBeenCalledWith('hovered');

        first.resolve();
        for (let index = 0; index < 20; index += 1) {
            await Promise.resolve();
        }

        expect(load.mock.calls.map((call) => call[0])).toEqual(['slow', 'hovered', 'queued']);
    });

    it('keeps draining after a failure and reports the error', async () => {
        const onError = vi.fn();
        const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
        const preloader = createSectionPreloader({ load, schedule: (run) => run(), onError });

        preloader.prefetch('broken');
        preloader.prefetch('healthy');

        for (let index = 0; index < 8; index += 1) {
            await Promise.resolve();
        }

        expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
        expect(preloader.isLoaded('healthy')).toBe(true);
    });
});
