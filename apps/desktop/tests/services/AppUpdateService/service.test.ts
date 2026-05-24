import { AppUpdateController } from '@services/AppUpdateService';
import type {
    AppUpdateChannel,
    AppUpdateCheckResult,
    AppUpdateInfo,
} from '@services/AppUpdateService/types';
import { describe, expect, it, vi } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

const availableUpdate: AppUpdateInfo = {
    version: '0.2.0',
    fileName: `${APP_PRODUCT_CONFIG.identifier}-0.2.0-full.nupkg`,
    notes: 'Bug fixes',
    sizeBytes: 12_000_000,
};

const neutralRequirement = {
    required: false,
    minimumSupportedVersion: null,
    requiredSeverity: null,
    requiredReason: null,
    targetSatisfiesRequirement: true,
};

function createController(
    options: {
        now?: string;
        channel?: AppUpdateChannel;
        autoCheckEnabled?: boolean;
        lastCheckedAt?: string | null;
        checkResult?: AppUpdateCheckResult;
        checkError?: Error;
    } = {}
) {
    const checkForUpdates = options.checkError
        ? vi.fn().mockRejectedValue(options.checkError)
        : vi.fn().mockImplementation((channel: AppUpdateChannel) =>
              Promise.resolve(
                  options.checkResult ?? {
                      status: 'available',
                      channel,
                      currentVersion: '0.1.0',
                      update: availableUpdate,
                      requirement: neutralRequirement,
                  }
              )
          );
    const downloadUpdate = vi.fn().mockResolvedValue(availableUpdate);
    const installUpdate = vi.fn().mockResolvedValue(true);
    const updateAppUpdateChannel = vi.fn().mockResolvedValue(undefined);
    const updateAppUpdateAutoCheck = vi.fn().mockResolvedValue(undefined);
    const updateAppUpdateLastCheckedAt = vi.fn().mockResolvedValue(undefined);

    const controller = new AppUpdateController({
        native: {
            checkForUpdates,
            downloadUpdate,
            installUpdate,
        },
        settings: {
            initialize: vi.fn().mockResolvedValue(undefined),
            getChannel: () => options.channel ?? 'stable',
            getAutoCheckEnabled: () => options.autoCheckEnabled ?? true,
            getLastCheckedAt: () => options.lastCheckedAt ?? null,
            updateAppUpdateChannel,
            updateAppUpdateAutoCheck,
            updateAppUpdateLastCheckedAt,
        },
        now: () => options.now ?? '2026-05-22T10:00:00.000Z',
    });

    return {
        controller,
        checkForUpdates,
        downloadUpdate,
        installUpdate,
        updateAppUpdateChannel,
        updateAppUpdateAutoCheck,
        updateAppUpdateLastCheckedAt,
    };
}

describe('AppUpdateController', () => {
    it('loads persisted settings before checking manually', async () => {
        const { controller, checkForUpdates, updateAppUpdateLastCheckedAt } = createController();

        await controller.initialize();
        await controller.checkNow('manual');

        expect(checkForUpdates).toHaveBeenCalledWith('stable');
        expect(updateAppUpdateLastCheckedAt).toHaveBeenCalledWith('2026-05-22T10:00:00.000Z');
        expect(controller.getState()).toMatchObject({
            status: 'available',
            channel: 'stable',
            availableUpdate,
            lastCheckedAt: '2026-05-22T10:00:00.000Z',
            error: null,
        });
    });

    it('skips automatic checks when the last check is less than 24 hours old', async () => {
        const { controller, checkForUpdates } = createController({
            now: '2026-05-22T10:00:00.000Z',
            lastCheckedAt: '2026-05-21T12:00:00.000Z',
        });

        await controller.initialize();
        const checked = await controller.checkNow('automatic');

        expect(checked).toBe(false);
        expect(checkForUpdates).not.toHaveBeenCalled();
    });

    it('runs automatic checks when the last check is at least 24 hours old', async () => {
        const { controller, checkForUpdates } = createController({
            now: '2026-05-22T10:00:00.000Z',
            lastCheckedAt: '2026-05-21T09:59:59.000Z',
        });

        await controller.initialize();
        const checked = await controller.checkNow('automatic');

        expect(checked).toBe(true);
        expect(checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('keeps automatic check failures low-noise', async () => {
        const { controller } = createController({
            checkError: new Error('network unavailable'),
        });

        await controller.initialize();
        const checked = await controller.checkNow('automatic');

        expect(checked).toBe(false);
        expect(controller.getState()).toMatchObject({
            status: 'idle',
            error: null,
        });
    });

    it('surfaces manual check failures', async () => {
        const { controller } = createController({
            checkError: new Error('network unavailable'),
        });

        await controller.initialize();
        const checked = await controller.checkNow('manual');

        expect(checked).toBe(false);
        expect(controller.getState()).toMatchObject({
            status: 'failed',
            error: 'network unavailable',
        });
    });

    it('downloads and installs the selected update', async () => {
        const { controller, downloadUpdate, installUpdate } = createController();

        await controller.initialize();
        await controller.checkNow('manual');
        await controller.download();
        await controller.install();

        expect(downloadUpdate).toHaveBeenCalledTimes(1);
        expect(installUpdate).toHaveBeenCalledTimes(1);
        expect(controller.getState().status).toBe('installing');
    });

    it('persists auto-check changes', async () => {
        const { controller, updateAppUpdateAutoCheck } = createController();

        await controller.initialize();
        await controller.setAutoCheckEnabled(false);

        expect(updateAppUpdateAutoCheck).toHaveBeenCalledWith(false);
        expect(controller.getState().autoCheckEnabled).toBe(false);
    });

    it('runs an immediate update check when auto-check is enabled', async () => {
        const { controller, checkForUpdates, updateAppUpdateAutoCheck } = createController({
            autoCheckEnabled: false,
            lastCheckedAt: '2026-05-22T09:00:00.000Z',
        });

        await controller.initialize();
        await controller.setAutoCheckEnabled(true);

        expect(updateAppUpdateAutoCheck).toHaveBeenCalledWith(true);
        expect(checkForUpdates).toHaveBeenCalledWith('stable');
        expect(controller.getState()).toMatchObject({
            autoCheckEnabled: true,
            status: 'available',
        });
    });

    it('checks the selected update channel and persists channel changes', async () => {
        const {
            controller,
            checkForUpdates,
            updateAppUpdateChannel,
            updateAppUpdateLastCheckedAt,
        } = createController({ channel: 'beta' });

        await controller.initialize();
        await controller.checkNow('manual');
        await controller.setChannel('nightly');
        await controller.checkNow('manual');

        expect(checkForUpdates).toHaveBeenNthCalledWith(1, 'beta');
        expect(checkForUpdates).toHaveBeenNthCalledWith(2, 'nightly');
        expect(updateAppUpdateChannel).toHaveBeenCalledWith('nightly');
        expect(updateAppUpdateLastCheckedAt).toHaveBeenCalledWith(null);
        expect(controller.getState()).toMatchObject({
            channel: 'nightly',
            status: 'available',
        });
    });
});
