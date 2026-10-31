import type { UpdateOperation, UpdatePhase } from '@services/AnalyticsService/lifecycle';
import { type AppUpdateAnalytics, AppUpdateController } from '@services/AppUpdateService';
import type {
    AppUpdateChannel,
    AppUpdateCheckResult,
    AppUpdateInfo,
} from '@services/AppUpdateService/types';
import { deferred, installProductAnalytics } from '@tests/utils/productAnalytics';
import { describe, expect, it, type Mock, vi } from 'vitest';

vi.mock('@services/ObservabilityService', () => ({
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const availableUpdate: AppUpdateInfo = {
    version: '0.2.0',
    fileName: 'TouchAI-0.2.0-full.nupkg',
    notes: null,
    sizeBytes: 12_000_000,
};

const neutralRequirement = {
    required: false,
    minimumSupportedVersion: null,
    requiredSeverity: null,
    requiredReason: null,
    targetSatisfiesRequirement: true,
};

function createAnalytics(): {
    analytics: AppUpdateAnalytics;
    begin: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    transitions: Array<{
        operation: UpdateOperation;
        phase: UpdatePhase;
        outcome: Record<string, unknown>;
    }>;
    finished: UpdateOperation[];
} {
    const transitions: Array<{
        operation: UpdateOperation;
        phase: UpdatePhase;
        outcome: Record<string, unknown>;
    }> = [];
    const finished: UpdateOperation[] = [];
    const begin = vi.fn(
        async (): Promise<UpdateOperation> => ({
            operation: { operationId: 'op-1', enabled: true, consentEpoch: 4 },
            updateOperationId: crypto.randomUUID(),
            closed: false,
            pending: Promise.resolve(),
        })
    );
    const finish = vi.fn(async (operation: UpdateOperation) => {
        finished.push(operation);
    });
    return {
        analytics: {
            beginUpdateOperation: begin,
            trackUpdateTransition: vi.fn(async (operation, phase, outcome) => {
                transitions.push({ operation, phase, outcome });
            }),
            finishUpdateOperation: finish,
        },
        begin,
        finish,
        transitions,
        finished,
    };
}

function createController(options: {
    checkResult?: AppUpdateCheckResult;
    downloadError?: Error;
    installError?: Error;
    analytics?: AppUpdateAnalytics;
    downloadUpdate?: Mock<
        (channel: AppUpdateChannel, version: string, fileName: string) => Promise<AppUpdateInfo>
    >;
    persistCheckedAt?: () => Promise<void>;
}) {
    const channel: AppUpdateChannel = 'stable';
    const checkForUpdates = vi.fn(
        async () =>
            options.checkResult ?? {
                status: 'available' as const,
                channel,
                currentVersion: '0.1.0',
                latest: null,
                update: availableUpdate,
                requirement: neutralRequirement,
            }
    );
    const downloadUpdate =
        options.downloadUpdate ??
        (options.downloadError
            ? vi.fn().mockRejectedValue(options.downloadError)
            : vi.fn().mockResolvedValue(availableUpdate));
    const installUpdate = options.installError
        ? vi.fn().mockRejectedValue(options.installError)
        : vi.fn().mockResolvedValue(true);

    const controller = new AppUpdateController({
        native: { checkForUpdates, downloadUpdate, installUpdate },
        settings: {
            initialize: vi.fn().mockResolvedValue(undefined),
            getChannel: () => channel,
            getAutoCheckEnabled: () => true,
            getLastCheckedAt: () => null,
            updateAppUpdateChannel: vi.fn().mockResolvedValue(undefined),
            updateAppUpdateAutoCheck: vi.fn().mockResolvedValue(undefined),
            updateAppUpdateLastCheckedAt:
                options.persistCheckedAt ?? vi.fn().mockResolvedValue(undefined),
        },
        analytics: options.analytics,
        now: () => '2026-05-22T10:00:00.000Z',
    });

    return { controller, checkForUpdates, downloadUpdate, installUpdate };
}

describe('user checks for an app update', () => {
    it('user keeps one update operation when download and install are requested while check persistence is pending', async () => {
        const telemetry = installProductAnalytics();
        const persistence = deferred<void>();
        const { controller, downloadUpdate, installUpdate } = createController({
            persistCheckedAt: () => persistence.promise,
        });
        const checking = controller.checkNow('manual');
        await vi.waitFor(() => expect(controller.getState().status).toBe('available'));

        await expect(controller.download()).resolves.toBe(false);
        await expect(controller.install()).resolves.toBe(false);
        expect(downloadUpdate).not.toHaveBeenCalled();
        expect(installUpdate).not.toHaveBeenCalled();
        expect(telemetry.released).toEqual([]);

        persistence.resolve();
        await expect(checking).resolves.toBe(true);
        await expect(controller.download()).resolves.toBe(true);
        await expect(controller.install()).resolves.toBe(true);
        await vi.waitFor(() => expect(telemetry.active.size).toBe(0));

        const transitions = telemetry.events.filter(
            (event) => event.eventName === 'app.update_transition'
        );
        expect(transitions.map((event) => event.attributes.phase)).toEqual([
            'check_started',
            'check_finished',
            'download_started',
            'download_finished',
            'install_handoff',
        ]);
        expect(new Set(transitions.map((event) => event.operationId))).toEqual(
            new Set(['operation-1'])
        );
        expect(new Set(transitions.map((event) => event.attributes.update_operation_id)).size).toBe(
            1
        );
        expect(telemetry.released).toEqual(['operation-1']);
        await controller.dispose();
    });

    it('user gets the started and finished check phases tied to one update operation', async () => {
        const analytics = createAnalytics();
        const { controller } = createController({ analytics: analytics.analytics });

        await controller.checkNow('manual');

        expect(analytics.transitions.map((entry) => entry.phase)).toEqual([
            'check_started',
            'check_finished',
        ]);
        const [started, finished] = analytics.transitions;
        expect(started?.operation.updateOperationId).toBe(finished?.operation.updateOperationId);
        expect(finished?.outcome).toMatchObject({
            result: 'success',
            source: 'user',
            toVersion: '0.2.0',
        });
        expect(analytics.finish).not.toHaveBeenCalled();
    });

    it('user gets a settings-open automatic check recorded away from user', async () => {
        const analytics = createAnalytics();
        const { controller } = createController({ analytics: analytics.analytics });

        await controller.checkNow('settings-open');

        const finished = analytics.transitions.find((entry) => entry.phase === 'check_finished');
        expect(finished?.outcome.source).toBe('other');
    });

    it('user gets an automatic check recorded with a background source', async () => {
        const analytics = createAnalytics();
        const { controller } = createController({ analytics: analytics.analytics });

        await controller.initialize();
        await controller.checkNow('automatic');

        const finished = analytics.transitions.find((entry) => entry.phase === 'check_finished');
        expect(finished?.outcome.source).toBe('background');
    });

    it('user gets an unavailable result when the platform is unsupported', async () => {
        const analytics = createAnalytics();
        const { controller } = createController({
            analytics: analytics.analytics,
            checkResult: {
                status: 'unsupported',
                channel: 'stable',
                currentVersion: '0.1.0',
                latest: null,
                reason: 'not_installed',
                message: 'not installed',
                requirement: neutralRequirement,
            },
        });

        await controller.checkNow('manual');

        const finished = analytics.transitions.find((entry) => entry.phase === 'check_finished');
        expect(finished?.outcome).toMatchObject({ result: 'unavailable' });
        await vi.waitFor(() => {
            expect(analytics.finish).toHaveBeenCalledTimes(1);
        });
    });

    it('user gets a fresh operation after a check ends with no available update', async () => {
        const analytics = createAnalytics();
        const { controller } = createController({
            analytics: analytics.analytics,
            checkResult: {
                status: 'not_available',
                channel: 'stable',
                currentVersion: '0.1.0',
                latest: null,
                requirement: neutralRequirement,
            },
        });

        await controller.checkNow('manual');
        await controller.checkNow('manual');
        await vi.waitFor(() => {
            expect(analytics.finish).toHaveBeenCalled();
        });

        expect(analytics.begin).toHaveBeenCalledTimes(2);
    });
});

describe('user downloads and installs an update', () => {
    it('user gets download phases that report the real outcome', async () => {
        const analytics = createAnalytics();
        const { controller } = createController({ analytics: analytics.analytics });

        await controller.checkNow('manual');
        await controller.download();

        const phases = analytics.transitions.map((entry) => entry.phase);
        expect(phases).toContain('download_started');
        expect(phases).toContain('download_finished');
        const finished = analytics.transitions.find((entry) => entry.phase === 'download_finished');
        expect(finished?.outcome).toMatchObject({ result: 'success', toVersion: '0.2.0' });
        expect(analytics.finish).not.toHaveBeenCalled();
    });

    it('user gets no early release when a second download starts in flight', async () => {
        const analytics = createAnalytics();
        let resolveDownload: (value: AppUpdateInfo) => void = () => undefined;
        const downloadUpdate = vi.fn(
            () =>
                new Promise<AppUpdateInfo>((resolve) => {
                    resolveDownload = resolve;
                })
        );
        const { controller } = createController({
            analytics: analytics.analytics,
            downloadUpdate,
        });

        await controller.checkNow('manual');
        const first = controller.download();
        await vi.waitFor(() => {
            expect(downloadUpdate).toHaveBeenCalledTimes(1);
        });

        await expect(controller.download()).resolves.toBe(false);
        expect(analytics.finish).not.toHaveBeenCalled();

        resolveDownload(availableUpdate);
        await expect(first).resolves.toBe(true);
        expect(analytics.finish).not.toHaveBeenCalled();
    });

    it('user gets a failure phase when the download fails', async () => {
        const analytics = createAnalytics();
        const { controller } = createController({
            analytics: analytics.analytics,
            downloadError: new Error('offline'),
        });

        await controller.checkNow('manual');
        await controller.download();

        const finished = analytics.transitions.find((entry) => entry.phase === 'download_finished');
        expect(finished?.outcome).toMatchObject({ result: 'failure' });
        await vi.waitFor(() => {
            expect(analytics.finish).toHaveBeenCalledTimes(1);
        });
    });

    it('user gets a handoff phase after install is invoked, never a confirmed restart', async () => {
        const analytics = createAnalytics();
        const { controller } = createController({ analytics: analytics.analytics });

        await controller.checkNow('manual');
        const downloaded = await controller.download();
        expect(downloaded).toBe(true);
        await controller.install();

        const phases = analytics.transitions.map((entry) => entry.phase);
        expect(phases).toContain('install_handoff');
        expect(phases).not.toContain('restart_confirmed');
        const handoff = analytics.transitions.find((entry) => entry.phase === 'install_handoff');
        expect(handoff?.outcome).toMatchObject({
            result: 'success',
            source: 'user',
            fromVersion: '0.1.0',
            toVersion: '0.2.0',
        });
        await vi.waitFor(() => {
            expect(analytics.finish).toHaveBeenCalledTimes(1);
        });
    });

    it('user gets the install handle released once when the installer fails', async () => {
        const analytics = createAnalytics();
        const { controller } = createController({
            analytics: analytics.analytics,
            installError: new Error('installer refused'),
        });

        await controller.checkNow('manual');
        await controller.download();
        await expect(controller.install()).resolves.toBe(false);
        await vi.waitFor(() => {
            expect(analytics.finish).toHaveBeenCalledTimes(1);
        });
    });

    it('user still sees an update failure when telemetry rejects', async () => {
        const finish = vi.fn().mockResolvedValue(undefined);
        const analytics: AppUpdateAnalytics = {
            beginUpdateOperation: vi.fn(async () => ({
                operation: { operationId: 'op', enabled: true, consentEpoch: 1 },
                updateOperationId: 'u',
                closed: false,
                pending: Promise.resolve(),
            })),
            trackUpdateTransition: vi.fn().mockRejectedValue(new Error('ipc down')),
            finishUpdateOperation: finish,
        };
        const { controller, installUpdate } = createController({
            analytics,
            installError: new Error('installer refused'),
        });

        await controller.checkNow('manual');
        await controller.download();

        await expect(controller.install()).resolves.toBe(false);
        expect(installUpdate).toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(finish).toHaveBeenCalledTimes(1);
        });
    });
});
