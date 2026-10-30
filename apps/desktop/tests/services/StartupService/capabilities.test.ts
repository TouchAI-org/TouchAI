import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    registerStartupCapability,
    resetStartupCapabilities,
    waitForAgentStartupCapabilities,
    whenStartupCapabilityReady,
} from '@/services/StartupService/capabilities';

describe('startup capability registry', () => {
    afterEach(() => {
        resetStartupCapabilities();
        vi.restoreAllMocks();
    });

    it('resolves immediately for capabilities that were never registered', async () => {
        await expect(whenStartupCapabilityReady('built-in-tools')).resolves.toBeUndefined();
    });

    it('waits for a registered capability and shares its settled promise', async () => {
        let release!: () => void;
        const task = new Promise<void>((resolve) => {
            release = resolve;
        });
        registerStartupCapability('built-in-tools', task);

        let settled = false;
        const waiting = whenStartupCapabilityReady('built-in-tools').then(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(settled).toBe(false);

        release();
        await waiting;
        expect(settled).toBe(true);
    });

    it('does not reject consumers when a capability fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        registerStartupCapability('model-metadata', Promise.reject(new Error('offline')));

        await expect(whenStartupCapabilityReady('model-metadata')).resolves.toBeUndefined();
    });

    it('waits for every agent capability before a request proceeds', async () => {
        let toolsDone = false;
        let metadataDone = false;
        registerStartupCapability(
            'built-in-tools',
            Promise.resolve().then(() => {
                toolsDone = true;
            })
        );
        registerStartupCapability(
            'model-metadata',
            Promise.resolve().then(() => {
                metadataDone = true;
            })
        );

        await waitForAgentStartupCapabilities();
        expect(toolsDone).toBe(true);
        expect(metadataDone).toBe(true);
    });
});
