import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { AppUpdateController } from '@/services/AppUpdateService';
import type { AppUpdateCheckResult } from '@/services/AppUpdateService/types';

afterEach(() => {
    vi.restoreAllMocks();
    setLocale('zh-CN');
});

function fixture() {
    let now = new Date(2026, 10, 10, 10).getTime();
    let checkedAt: string | null = null;
    const result: AppUpdateCheckResult = {
        status: 'not_available',
        channel: 'stable',
        currentVersion: '1.2.3',
        latest: null,
        requirement: {
            required: false,
            minimumSupportedVersion: null,
            requiredSeverity: null,
            requiredReason: null,
            targetSatisfiesRequirement: true,
        },
    };
    const check = vi.fn<() => Promise<AppUpdateCheckResult>>().mockResolvedValue(result);
    const controller = new AppUpdateController({
        native: { checkForUpdates: check, downloadUpdate: vi.fn(), installUpdate: vi.fn() },
        settings: {
            initialize: async () => {},
            getChannel: () => 'stable',
            getAutoCheckEnabled: () => true,
            getLastCheckedAt: () => checkedAt,
            updateAppUpdateChannel: async () => {},
            updateAppUpdateAutoCheck: async () => {},
            updateAppUpdateLastCheckedAt: async (value) => {
                checkedAt = value;
            },
        },
        now: () => new Date(now).toISOString(),
    });
    return {
        controller,
        check,
        result,
        advance: (milliseconds: number) => {
            now += milliseconds;
        },
    };
}

describe('given a disconnected network', () => {
    it('user gets a quiet offline skip and an immediate automatic check after reconnecting', async () => {
        const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const { controller, check } = fixture();
        await expect(controller.checkNow('automatic')).resolves.toBe(false);
        expect(check).not.toHaveBeenCalled();
        expect(controller.getState()).toMatchObject({ error: null, lastCheckedAt: null });
        online.mockReturnValue(true);
        await expect(controller.checkNow('automatic')).resolves.toBe(true);
        await controller.dispose();
    });

    it.each([
        ['zh-CN', '网络已断开'],
        ['en-US', 'You are offline'],
    ])(
        'user gets reconnection guidance after an offline manual check fails in %s',
        async (locale, text) => {
            setLocale(locale);
            vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
            const { controller, check } = fixture();
            check.mockRejectedValue(new Error('connection refused'));
            await expect(controller.checkNow('manual')).resolves.toBe(false);
            expect(controller.getState().error).toContain(text);
            await controller.dispose();
        }
    );

    it('user can still check manually when the operating system reports a false offline hint', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const { controller } = fixture();
        await expect(controller.checkNow('manual')).resolves.toBe(true);
        await controller.dispose();
    });
});

describe('given repeated update-service failures', () => {
    it('user gets bounded retries with increasing delays and returns to hourly checks after success', async () => {
        const { controller, check, result, advance } = fixture();
        check.mockRejectedValue(new Error('server unavailable'));
        await controller.checkNow('automatic');
        advance(59_999);
        await controller.checkNow('automatic');
        expect(check).toHaveBeenCalledTimes(1);
        advance(1);
        await controller.checkNow('automatic');
        expect(check).toHaveBeenCalledTimes(2);
        advance(60_000);
        await controller.checkNow('automatic');
        expect(check).toHaveBeenCalledTimes(2);
        advance(60_000);
        check.mockResolvedValue(result);
        await expect(controller.checkNow('automatic')).resolves.toBe(true);
        advance(60_000);
        await expect(controller.checkNow('automatic')).resolves.toBe(false);
        expect(controller.getState()).toMatchObject({ status: 'not_available', error: null });
        await controller.dispose();
    });

    it('user can always request a manual retry during automatic backoff', async () => {
        const { controller, check, result } = fixture();
        check.mockRejectedValueOnce(new Error('server unavailable')).mockResolvedValue(result);
        await controller.checkNow('automatic');
        await expect(controller.checkNow('manual')).resolves.toBe(true);
        await controller.dispose();
    });
});
