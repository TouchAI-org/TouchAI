import { native } from '@services/NativeService';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/NativeService', () => ({
    native: {
        analytics: {
            getState: vi.fn(),
            setEnabled: vi.fn(),
            clearPending: vi.fn(),
        },
    },
}));

vi.mock('@services/ObservabilityService', () => ({
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { setLocale } from '@/i18n';
import AnalyticsSection from '@/views/SettingsView/components/General/AnalyticsSection.vue';

const nativeAnalytics = vi.mocked(native.analytics);

function state(partial: Partial<Awaited<ReturnType<typeof native.analytics.getState>>> = {}) {
    return {
        status: 'enabled' as const,
        consentEpoch: 1,
        queueDepth: 0,
        pendingBytes: 0,
        transportReady: true,
        ...partial,
    };
}

describe('user configures product analytics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('en-US');
    });

    it('user turns sharing on and the native runtime records the choice with the current epoch', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ status: 'disabled', consentEpoch: 2 }));
        nativeAnalytics.setEnabled.mockResolvedValue(state({ status: 'enabled', consentEpoch: 3 }));

        const wrapper = mount(AnalyticsSection);
        await flushPromises();

        expect(wrapper.text()).toContain('Product analytics');
        await wrapper.get('[data-testid="settings-analytics-toggle"]').trigger('click');
        await flushPromises();

        expect(nativeAnalytics.setEnabled).toHaveBeenCalledWith(true, 2);
    });

    it('user sees the no-send disclosure and a disabled toggle when the build is unprovisioned', async () => {
        nativeAnalytics.getState.mockResolvedValue(
            state({ status: 'uninitialized', consentEpoch: 0, transportReady: false })
        );

        const wrapper = mount(AnalyticsSection);
        await flushPromises();

        expect(wrapper.text()).toContain('no analytics endpoint configured');
        const toggle = wrapper.get('[data-testid="settings-analytics-toggle"]');
        expect((toggle.element as HTMLButtonElement).disabled).toBe(true);
    });

    it('user clears pending data and the queue row disappears', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ queueDepth: 3, pendingBytes: 500 }));
        nativeAnalytics.clearPending.mockResolvedValue(state({ consentEpoch: 1, queueDepth: 0 }));

        const wrapper = mount(AnalyticsSection);
        await flushPromises();

        await wrapper.get('[data-testid="settings-analytics-clear"]').trigger('click');
        await flushPromises();

        expect(nativeAnalytics.clearPending).toHaveBeenCalledWith(1);
        expect(wrapper.find('[data-testid="settings-analytics-clear"]').exists()).toBe(false);
    });

    it('user is told when a clear loses a consent race instead of a false success', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ queueDepth: 3, consentEpoch: 1 }));
        nativeAnalytics.clearPending.mockRejectedValue(new Error('stale_consent_epoch'));

        const wrapper = mount(AnalyticsSection);
        await flushPromises();

        await wrapper.get('[data-testid="settings-analytics-clear"]').trigger('click');
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-analytics-clear"]').exists()).toBe(true);
        expect(nativeAnalytics.getState).toHaveBeenCalledTimes(2);
    });
});
