import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStartupCapabilities } from '@/app/bootstrap/capabilities';

let capabilities: ReturnType<typeof createStartupCapabilities>;
describe('given instance-scoped production startup readiness', () => {
    beforeEach(() => {
        capabilities = createStartupCapabilities(() => {});
    });
    afterEach(() => {
        capabilities.dispose();
    });

    it('user when opening a lightweight client then waits for no unregistered capability', async () => {
        await expect(capabilities.whenReady('built-in-tools')).resolves.toBeUndefined();
    });

    it('user when starting before a capability is ready then waits for its completion', async () => {
        let release!: () => void;
        const task = new Promise<void>((resolve) => {
            release = resolve;
        });
        capabilities.register('built-in-tools', task);

        let settled = false;
        const waiting = capabilities.whenReady('built-in-tools').then(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(settled).toBe(false);

        release();
        await waiting;
        expect(settled).toBe(true);
    });

    it('user when an optional warmup fails then can still proceed', async () => {
        capabilities.register('model-metadata', Promise.reject(new Error('offline')));

        await expect(capabilities.whenReady('model-metadata')).resolves.toBeUndefined();
    });

    it('user when an agent request starts then waits for all registered dependencies', async () => {
        let toolsDone = false;
        let metadataDone = false;
        capabilities.register(
            'built-in-tools',
            Promise.resolve().then(() => {
                toolsDone = true;
            })
        );
        capabilities.register(
            'model-metadata',
            Promise.resolve().then(() => {
                metadataDone = true;
            })
        );

        await capabilities.waitForAgent();
        expect(toolsDone).toBe(true);
        expect(metadataDone).toBe(true);
    });
});
