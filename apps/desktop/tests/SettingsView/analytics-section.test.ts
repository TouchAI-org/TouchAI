import { native } from '@services/NativeService';
import { log } from '@services/ObservabilityService';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/NativeService', () => ({
    native: {
        analytics: {
            getState: vi.fn(),
            setEnabled: vi.fn(),
        },
    },
}));

vi.mock('@services/ObservabilityService', () => ({
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { setLocale } from '@/i18n';
import AnalyticsSection from '@/views/SettingsView/components/DataManagement/components/AnalyticsSection.vue';

const nativeAnalytics = vi.mocked(native.analytics);

function state(partial: Partial<Awaited<ReturnType<typeof native.analytics.getState>>> = {}) {
    return {
        status: 'enabled' as const,
        consentEpoch: 1,
        queueDepth: 0,
        pendingBytes: 0,
        buildEligible: true,
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

        expect(wrapper.text()).toContain('Privacy and product analytics');
        expect(wrapper.get('[data-testid="settings-analytics-share"]').text()).toContain(
            'Share feature usage and performance statistics, without conversation or file contents. Turn off to stop sending.'
        );
        const toggle = wrapper.get('[data-testid="settings-analytics-toggle"]');
        expect((toggle.element as HTMLButtonElement).disabled).toBe(false);
        await toggle.trigger('click');
        await flushPromises();

        expect(nativeAnalytics.setEnabled).toHaveBeenCalledWith(true, 2);
    });

    it('user can turn sharing off in a development build with a stored enabled choice', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ buildEligible: false }));
        nativeAnalytics.setEnabled.mockResolvedValue(
            state({ status: 'disabled', consentEpoch: 2, buildEligible: false })
        );

        const wrapper = mount(AnalyticsSection);
        await flushPromises();

        const toggle = wrapper.get('[data-testid="settings-analytics-toggle"]');
        expect((toggle.element as HTMLButtonElement).disabled).toBe(false);
        await toggle.trigger('click');
        await flushPromises();

        expect(nativeAnalytics.setEnabled).toHaveBeenCalledWith(false, 1);
    });

    it('user cannot turn sharing on in a development build', async () => {
        nativeAnalytics.getState.mockResolvedValue(
            state({ status: 'disabled', consentEpoch: 2, buildEligible: false })
        );

        const wrapper = mount(AnalyticsSection);
        await flushPromises();

        const toggle = wrapper.get('[data-testid="settings-analytics-toggle"]');
        expect((toggle.element as HTMLButtonElement).disabled).toBe(true);
        await toggle.trigger('click');
        expect(nativeAnalytics.setEnabled).not.toHaveBeenCalled();
    });

    it('user can turn sharing off when the transport is not ready', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ transportReady: false }));
        nativeAnalytics.setEnabled.mockResolvedValue(
            state({ status: 'disabled', consentEpoch: 2, transportReady: false })
        );

        const wrapper = mount(AnalyticsSection);
        await flushPromises();

        const toggle = wrapper.get('[data-testid="settings-analytics-toggle"]');
        expect((toggle.element as HTMLButtonElement).disabled).toBe(false);
        await toggle.trigger('click');
        await flushPromises();

        expect(nativeAnalytics.setEnabled).toHaveBeenCalledWith(false, 1);
    });

    it('user gets the standard privacy disclosure when transport is unprovisioned', async () => {
        nativeAnalytics.getState.mockResolvedValue(
            state({ status: 'uninitialized', consentEpoch: 0, transportReady: false })
        );

        const wrapper = mount(AnalyticsSection);
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-analytics-share"]').text()).toContain(
            'Share feature usage and performance statistics, without conversation or file contents. Turn off to stop sending.'
        );
        expect(wrapper.text()).not.toContain('analytics endpoint');
        const toggle = wrapper.get('[data-testid="settings-analytics-toggle"]');
        expect((toggle.element as HTMLButtonElement).disabled).toBe(true);
    });

    it('user does not see internal queue controls when pending data exists', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ queueDepth: 3, pendingBytes: 500 }));

        const wrapper = mount(AnalyticsSection);
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-analytics-clear"]').exists()).toBe(false);
        expect(log.debug).toHaveBeenCalledWith(
            '[Analytics] State',
            expect.objectContaining({ queueDepth: 3, pendingBytes: 500 })
        );
    });

    it('user opens the privacy details and can read the full disclosure without changing consent', async () => {
        nativeAnalytics.getState.mockResolvedValue(state());
        const wrapper = mount(AnalyticsSection, { attachTo: document.body });
        await flushPromises();

        expect(wrapper.text()).not.toContain('random installation id');
        await wrapper.get('[data-testid="settings-analytics-details"]').trigger('click');
        await flushPromises();

        const dialog = document.querySelector('[role=dialog]');
        expect(dialog?.textContent).toContain('random installation id');
        expect(dialog?.textContent).toContain('IP address and coarse location');
        expect(dialog?.textContent).toContain('after sharing is enabled');
        expect(nativeAnalytics.setEnabled).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});
