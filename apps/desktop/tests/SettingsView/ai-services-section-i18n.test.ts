import { network } from '@tests/utils/agentWindow';
import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import AiServicesView from '@/views/SettingsView/components/AiServices/index.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(async () => {
    wrapper?.unmount();
    await fixture?.dispose();
    vi.unstubAllGlobals();
});

describe('given a saved custom provider and the production settings client', () => {
    it('user given a runtime language change when reopening the provider menu then reads the translated edit and delete commands', async () => {
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            }
        );
        fixture = await createSettingsPanelFixture();
        network.respondToDiscovery = async () => new Response(null, { status: 304 });
        setLocale('zh-CN');
        wrapper = mount(AiServicesView, fixture.viewOptions);
        await flushPromises();
        await wrapper.get('.provider-card').trigger('contextmenu', { clientX: 20, clientY: 20 });
        await flushPromises();
        expect(
            [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
                item.textContent?.trim()
            )
        ).toEqual(['编辑', '删除']);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        setLocale('en-US');
        await flushPromises();
        await wrapper.get('.provider-card').trigger('contextmenu', { clientX: 20, clientY: 20 });
        await flushPromises();
        expect(
            [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
                item.textContent?.trim()
            )
        ).toEqual(['Edit', 'Delete']);
    });
});
