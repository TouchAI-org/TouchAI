import { network } from '@tests/utils/agentWindow';
import { installProductAnalytics } from '@tests/utils/productAnalytics';
import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import AiServices from '@/views/SettingsView/components/AiServices/index.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
let wrapper: ReturnType<typeof mount> | undefined;
beforeEach(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
});
afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    await fixture?.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('given the actual AI settings panel and its main host', () => {
    it('user given a closed main host when editing a profile then cannot save through a local database fallback', async () => {
        fixture = await createSettingsPanelFixture();
        installProductAnalytics();
        network.respondToDiscovery = async () => new Response(null, { status: 304 });
        setLocale('en-US');
        wrapper = mount(AiServices, fixture.viewOptions);
        await flushPromises();
        const endpoint = wrapper.get('[data-settings-search-target="provider-endpoint"] input');
        await fixture.window.dispose();
        vi.useFakeTimers();
        await endpoint.setValue('https://late.invalid/v1');
        await vi.advanceTimersByTimeAsync(800);
        await flushPromises();
        expect(
            fixture.database.prepare('SELECT api_endpoint FROM providers WHERE id = 1').get()
        ).toEqual({ api_endpoint: 'https://fixture.invalid/v1' });
        await vi.advanceTimersByTimeAsync(5_000);
        await flushPromises();
        expect(document.body.textContent).toContain('Failed to save');
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
