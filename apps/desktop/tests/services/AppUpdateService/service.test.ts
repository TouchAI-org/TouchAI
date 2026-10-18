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

const latestUpdate = {
    version: '0.2.0',
    tag: 'v0.2.0',
    releaseUrl: `${APP_PRODUCT_CONFIG.repository.releasesUrl}/tag/v0.2.0`,
    publishedAt: '2026-05-22T09:00:00.000Z',
    prerelease: false,
    releaseNotes: '## 更新日志\n\n- 修复问题',
    downloads: [
        {
            kind: 'installer',
            name: 'TouchAI-0.2.0-windows.msi',
            url: `${APP_PRODUCT_CONFIG.services.updates.baseUrl}/TouchAI-0.2.0-windows.msi`,
            sizeBytes: 12_000_000,
        },
    ],
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
        checkEvents?: ConstructorParameters<typeof AppUpdateController>[0]['checkEvents'];
    } = {}
) {
    let channel = options.channel ?? 'stable';
    let autoCheckEnabled = options.autoCheckEnabled ?? true;
    let lastCheckedAt = options.lastCheckedAt ?? null;
    const checkForUpdates = options.checkError
        ? vi.fn().mockRejectedValue(options.checkError)
        : vi.fn().mockImplementation((channel: AppUpdateChannel) =>
              Promise.resolve(
                  options.checkResult ?? {
                      status: 'available',
                      channel,
                      currentVersion: '0.1.0',
                      latest: latestUpdate,
                      update: availableUpdate,
                      requirement: neutralRequirement,
                  }
              )
          );
    const downloadUpdate = vi.fn().mockResolvedValue(availableUpdate);
    const installUpdate = vi.fn().mockResolvedValue(true);
    const updateAppUpdateChannel = vi.fn(async (value: AppUpdateChannel) => {
        channel = value;
    });
    const updateAppUpdateAutoCheck = vi.fn(async (value: boolean) => {
        autoCheckEnabled = value;
    });
    const updateAppUpdateLastCheckedAt = vi.fn(async (value: string | null) => {
        lastCheckedAt = value;
    });

    const controller = new AppUpdateController({
        native: {
            checkForUpdates,
            downloadUpdate,
            installUpdate,
        },
        settings: {
            initialize: vi.fn().mockResolvedValue(undefined),
            getChannel: () => channel,
            getAutoCheckEnabled: () => autoCheckEnabled,
            getLastCheckedAt: () => lastCheckedAt,
            updateAppUpdateChannel,
            updateAppUpdateAutoCheck,
            updateAppUpdateLastCheckedAt,
        },
        now: () => options.now ?? '2026-05-22T10:00:00.000Z',
        checkEvents: options.checkEvents,
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

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return { promise, resolve, reject };
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
            latestUpdate,
            lastCheckedAt: '2026-05-22T10:00:00.000Z',
            error: null,
        });
    });

    it('skips automatic checks when the last check is less than an hour old', async () => {
        const { controller, checkForUpdates } = createController({
            now: '2026-05-22T10:00:00.000Z',
            lastCheckedAt: '2026-05-22T09:00:01.000Z',
        });

        await controller.initialize();
        const checked = await controller.checkNow('automatic');

        expect(checked).toBe(false);
        expect(checkForUpdates).not.toHaveBeenCalled();
    });

    it('runs automatic checks when the last check is at least an hour old', async () => {
        const { controller, checkForUpdates } = createController({
            now: '2026-05-22T10:00:00.000Z',
            lastCheckedAt: '2026-05-22T09:00:00.000Z',
        });

        await controller.initialize();
        const checked = await controller.checkNow('automatic');

        expect(checked).toBe(true);
        expect(checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it.each([0, 7])('skips automatic checks at %s:00 local time', async (hour) => {
        const { controller, checkForUpdates } = createController({
            now: new Date(2026, 9, 18, hour).toISOString(),
        });

        await expect(controller.checkNow('automatic')).resolves.toBe(false);
        expect(checkForUpdates).not.toHaveBeenCalled();
    });

    it('starts automatic checks at 08:00 even after a recent quiet-hours settings check', async () => {
        const { controller, checkForUpdates } = createController({
            now: new Date(2026, 9, 18, 8).toISOString(),
            lastCheckedAt: new Date(2026, 9, 18, 7, 30).toISOString(),
        });

        await expect(controller.checkNow('automatic')).resolves.toBe(true);
        expect(checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('still checks immediately when settings open during quiet hours', async () => {
        const { controller, checkForUpdates } = createController({
            now: new Date(2026, 9, 18, 2).toISOString(),
        });

        await expect(controller.checkNow('settings-open')).resolves.toBe(true);
        expect(checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('checks on settings open even when automatic checks are disabled and a check is recent', async () => {
        const { controller, checkForUpdates } = createController({
            autoCheckEnabled: false,
            lastCheckedAt: '2026-05-22T09:59:00.000Z',
        });

        await expect(controller.checkNow('settings-open')).resolves.toBe(true);

        expect(checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('coalesces startup and settings-open checks during initialization', async () => {
        const deferredCheck = createDeferred<AppUpdateCheckResult>();
        const { controller, checkForUpdates } = createController();
        checkForUpdates.mockReturnValueOnce(deferredCheck.promise);

        const startupCheck = controller.checkNow('automatic');
        const settingsCheck = controller.checkNow('settings-open');

        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
        deferredCheck.resolve({
            status: 'available',
            channel: 'stable',
            currentVersion: '0.1.0',
            latest: latestUpdate,
            update: availableUpdate,
            requirement: neutralRequirement,
        });

        await expect(Promise.all([startupCheck, settingsCheck])).resolves.toEqual([true, true]);
        expect(controller.getState().status).toBe('available');
    });

    it('keeps settings-open failures quiet while retaining a known update', async () => {
        const { controller, checkForUpdates } = createController();
        await controller.checkNow('manual');
        checkForUpdates.mockRejectedValueOnce(new Error('network unavailable'));

        await expect(controller.checkNow('settings-open')).resolves.toBe(false);

        expect(controller.getState()).toMatchObject({
            status: 'available',
            availableUpdate,
            error: null,
        });
    });

    it('surfaces a failed first settings-open check instead of restoring idle', async () => {
        const { controller } = createController({
            checkError: new Error('network unavailable'),
            lastCheckedAt: '2026-05-22T09:59:00.000Z',
        });

        await expect(controller.checkNow('settings-open')).resolves.toBe(false);

        expect(controller.getState()).toMatchObject({
            status: 'failed',
            error: 'network unavailable',
        });
    });

    it('surfaces initial settings-open errors when joining a background check', async () => {
        const deferredCheck = createDeferred<AppUpdateCheckResult>();
        const { controller, checkForUpdates } = createController();
        checkForUpdates.mockReturnValueOnce(deferredCheck.promise);
        const backgroundCheck = controller.checkNow('automatic');
        await vi.waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
        const settingsCheck = controller.checkNow('settings-open');
        await Promise.resolve();
        deferredCheck.reject(new Error('network unavailable'));

        await expect(Promise.all([backgroundCheck, settingsCheck])).resolves.toEqual([
            false,
            false,
        ]);
        expect(controller.getState()).toMatchObject({
            status: 'failed',
            error: 'network unavailable',
        });
    });

    it('shares completed checks with other windows and accepts their results without another request', async () => {
        let receiveCheck!: (result: AppUpdateCheckResult, checkedAt: string) => void;
        const checkEvents = {
            listen: vi.fn(async (listener: typeof receiveCheck) => {
                receiveCheck = listener;
                return () => undefined;
            }),
            publish: vi.fn().mockResolvedValue(undefined),
        };
        const { controller, checkForUpdates } = createController({ checkEvents });
        await controller.checkNow('manual');

        expect(checkEvents.publish).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'available' }),
            '2026-05-22T10:00:00.000Z'
        );

        receiveCheck(
            {
                status: 'not_available',
                channel: 'stable',
                currentVersion: '0.2.0',
                latest: latestUpdate,
                requirement: neutralRequirement,
            },
            '2026-05-22T13:00:00.000Z'
        );

        expect(controller.getState()).toMatchObject({
            status: 'not_available',
            availableUpdate: null,
            lastCheckedAt: '2026-05-22T13:00:00.000Z',
        });
        expect(checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('preserves a downloaded update when opening settings or checking automatically', async () => {
        const { controller, checkForUpdates } = createController();
        await controller.checkNow('manual');
        await controller.download();
        checkForUpdates.mockClear();

        await controller.checkNow('settings-open');
        await controller.checkNow('automatic');

        expect(checkForUpdates).not.toHaveBeenCalled();
        expect(controller.getState()).toMatchObject({
            status: 'downloaded',
            downloadedUpdate: availableUpdate,
        });
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

    it('waits an hour before retrying a failed automatic check', async () => {
        const { controller, checkForUpdates } = createController({
            checkError: new Error('network unavailable'),
        });

        await controller.checkNow('automatic');
        await controller.checkNow('automatic');

        expect(checkForUpdates).toHaveBeenCalledTimes(1);
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

        expect(downloadUpdate).toHaveBeenCalledWith('stable', '0.2.0', availableUpdate.fileName);
        expect(installUpdate).toHaveBeenCalledWith('stable', '0.2.0', availableUpdate.fileName);
        expect(controller.getState().status).toBe('installing');
    });

    it('does not ask native to download or install without the selected update', async () => {
        const { controller, downloadUpdate, installUpdate } = createController();

        await expect(controller.download()).resolves.toBe(false);
        await expect(controller.install()).resolves.toBe(false);
        expect(downloadUpdate).not.toHaveBeenCalled();
        expect(installUpdate).not.toHaveBeenCalled();
    });

    it('rejects a download result that differs from the requested update', async () => {
        const { controller, downloadUpdate, installUpdate } = createController();
        await controller.checkNow('manual');
        downloadUpdate.mockResolvedValueOnce({ ...availableUpdate, version: '0.3.0' });

        await expect(controller.download()).resolves.toBe(false);
        expect(controller.getState().status).not.toBe('downloaded');
        await expect(controller.install()).resolves.toBe(false);
        expect(installUpdate).not.toHaveBeenCalled();
    });

    it('rejects a download result for a different package of the same version', async () => {
        const { controller, downloadUpdate } = createController();
        await controller.checkNow('manual');
        downloadUpdate.mockResolvedValueOnce({ ...availableUpdate, fileName: 'other.nupkg' });

        await expect(controller.download()).resolves.toBe(false);
        expect(controller.getState().status).not.toBe('downloaded');
    });

    it('does not let stale download completion overwrite a changed channel', async () => {
        const deferredDownload = createDeferred<AppUpdateInfo>();
        const { controller, downloadUpdate } = createController();
        downloadUpdate.mockReturnValueOnce(deferredDownload.promise);

        await controller.initialize();
        await controller.checkNow('manual');
        const downloadPromise = controller.download();
        await Promise.resolve();

        expect(controller.getState().status).toBe('downloading');
        await controller.setChannel('nightly');

        deferredDownload.resolve(availableUpdate);
        await expect(downloadPromise).resolves.toBe(true);

        expect(controller.getState()).toMatchObject({
            status: 'idle',
            channel: 'nightly',
            downloadedUpdate: null,
            downloadProgress: null,
            error: null,
        });
    });

    it('does not let stale download failure overwrite a changed channel', async () => {
        const deferredDownload = createDeferred<AppUpdateInfo>();
        const { controller, downloadUpdate } = createController();
        downloadUpdate.mockReturnValueOnce(deferredDownload.promise);

        await controller.initialize();
        await controller.checkNow('manual');
        const downloadPromise = controller.download();
        await Promise.resolve();

        expect(controller.getState().status).toBe('downloading');
        await controller.setChannel('nightly');

        deferredDownload.reject(new Error('download failed'));
        await expect(downloadPromise).resolves.toBe(false);

        expect(controller.getState()).toMatchObject({
            status: 'idle',
            channel: 'nightly',
            downloadedUpdate: null,
            downloadProgress: null,
            error: null,
        });
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
