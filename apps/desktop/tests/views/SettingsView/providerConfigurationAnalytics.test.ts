import type { Provider } from '@database/schema';
import { deferred, installProductAnalytics } from '@tests/utils/productAnalytics';
import { mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import AiServicesSection from '@/views/SettingsView/components/AiServices/index.vue';

vi.mock('@tauri-apps/plugin-http', () => ({
    fetch: vi.fn(
        async () =>
            new Response('{"data":[]}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}));

function provider(id: number): Provider {
    return {
        id,
        name: `Provider ${id}`,
        driver: 'openai',
        api_endpoint: `https://provider-${id}.example/v1`,
        api_key: null,
        config_json: null,
        logo: 'openai.svg',
        enabled: 1,
        is_builtin: 0,
        created_at: '',
        updated_at: '',
    };
}

describe('user saves provider configuration', () => {
    let telemetry: ReturnType<typeof installProductAnalytics>;
    let pendingSave: ReturnType<typeof deferred<void>> | null;
    let saveError: Error | null;
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const wrappers: ReturnType<typeof mount>[] = [];

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            }
        );
        setLocale('en-US');
        telemetry = installProductAnalytics();
        pendingSave = null;
        saveError = null;
        writes.length = 0;
        mockTauriCommand('database_query', async (payload: unknown) => {
            const { request } = payload as {
                request: { sql: string; params: unknown[]; method: string };
            };
            if (request.sql.startsWith('update "providers"')) {
                writes.push(request);
                if (saveError) throw saveError;
                await pendingSave?.promise;
                return { rows: [], rowsAffected: 1, lastInsertId: null };
            }
            let rows: object[] = [];
            if (request.sql.includes('from "providers"') && !request.sql.includes('join')) {
                rows =
                    request.method === 'get'
                        ? [provider(Number(request.params[0]))]
                        : [provider(1), provider(2)];
            } else if (request.sql.includes('from "statistics"')) {
                rows = [{ key: request.params[0], value: new Date().toISOString() }];
            } else if (request.sql.includes('count(*)')) {
                rows = [{ count: 1 }];
            }
            return { rows, rowsAffected: 0, lastInsertId: null };
        });
    });

    afterEach(() => {
        wrappers.forEach((wrapper) => wrapper.unmount());
        wrappers.length = 0;
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    async function settings() {
        const wrapper = mount(AiServicesSection, { attachTo: document.body });
        wrappers.push(wrapper);
        await flushPromises();
        expect(
            wrapper.get('[data-settings-search-target="provider-endpoint"] input').element
        ).toBeTruthy();
        return wrapper;
    }
    const starts = () =>
        telemetry.events.filter((event) => event.eventName === 'provider.configuration_started');
    const completions = () =>
        telemetry.events.filter((event) => event.eventName === 'provider.configuration_completed');

    it('user keeps the original edit attempt when reselecting the same provider before the save', async () => {
        const wrapper = await settings();
        await wrapper
            .get('[data-settings-search-target="provider-endpoint"] input')
            .setValue('https://edited.example/v1');
        await flushPromises();
        await wrapper.findAll('.provider-card')[0]!.trigger('click');
        await vi.advanceTimersByTimeAsync(800);
        await flushPromises();

        expect(writes).toHaveLength(1);
        expect(writes[0]?.params).toContain('https://edited.example/v1');
        expect(writes[0]?.params[writes[0].params.length - 1]).toBe(1);
        expect(starts()).toHaveLength(1);
        expect(completions()).toEqual([
            expect.objectContaining({
                operationId: starts()[0]?.operationId,
                attributes: expect.objectContaining({
                    configuration_id: starts()[0]?.attributes.configuration_id,
                    result: 'success',
                }),
            }),
        ]);
        expect(telemetry.released).toEqual(['operation-1']);
    });

    it('user cancels the old provider debounce when switching and saves only the newly edited provider', async () => {
        const wrapper = await settings();
        await wrapper
            .get('[data-settings-search-target="provider-endpoint"] input')
            .setValue('https://abandoned.example/v1');
        await wrapper.findAll('.provider-card')[1]!.trigger('click');
        await vi.advanceTimersByTimeAsync(800);
        await flushPromises();
        expect(writes).toEqual([]);
        expect(completions()).toEqual([]);
        expect(telemetry.released).toEqual(['operation-1']);

        await wrapper
            .get('[data-settings-search-target="provider-endpoint"] input')
            .setValue('https://second.example/v1');
        await vi.advanceTimersByTimeAsync(800);
        await flushPromises();
        expect(writes).toHaveLength(1);
        expect(writes[0]?.params).toContain('https://second.example/v1');
        expect(writes[0]?.params[writes[0].params.length - 1]).toBe(2);
        expect(starts()).toHaveLength(2);
        expect(completions()[0]?.operationId).toBe('operation-2');
    });

    it('user finishes the original provider save after switching while persistence is pending', async () => {
        pendingSave = deferred<void>();
        const wrapper = await settings();
        await wrapper
            .get('[data-settings-search-target="provider-endpoint"] input')
            .setValue('https://first.example/v1');
        await vi.advanceTimersByTimeAsync(800);
        await flushPromises();
        await wrapper.findAll('.provider-card')[1]!.trigger('click');
        pendingSave.resolve();
        await flushPromises();

        expect(writes[0]?.params[writes[0].params.length - 1]).toBe(1);
        expect(
            wrapper.get('[data-settings-search-target="provider-endpoint"] input').element
        ).toHaveProperty('value', 'https://provider-2.example/v1');
        expect(completions()[0]?.operationId).toBe('operation-1');
        expect(starts()).toHaveLength(1);
        expect(telemetry.released).toEqual(['operation-1']);
    });

    it('user gets a failed save and a fresh successful attempt after correcting another edit', async () => {
        saveError = new Error('save refused');
        const wrapper = await settings();
        await wrapper
            .get('[data-settings-search-target="provider-endpoint"] input')
            .setValue('https://failed.example/v1');
        await vi.advanceTimersByTimeAsync(800);
        await flushPromises();
        expect(completions()[0]?.attributes.result).toBe('failure');

        saveError = null;
        await wrapper
            .get('[data-settings-search-target="provider-endpoint"] input')
            .setValue('https://retry.example/v1');
        await vi.advanceTimersByTimeAsync(800);
        await flushPromises();
        expect(starts()).toHaveLength(2);
        expect(completions().map((event) => event.attributes.result)).toEqual([
            'failure',
            'success',
        ]);
        expect(telemetry.released).toEqual(['operation-1', 'operation-2']);
    });

    it('user cancels the pending edit without a fabricated save on leaving settings', async () => {
        const wrapper = await mount(AiServicesSection);
        await flushPromises();
        await wrapper
            .get('[data-settings-search-target="provider-endpoint"] input')
            .setValue('https://abandoned.example/v1');
        wrapper.unmount();
        await vi.advanceTimersByTimeAsync(800);
        await flushPromises();
        expect(writes).toEqual([]);
        expect(completions()).toEqual([]);
        expect(telemetry.released).toEqual(['operation-1']);
    });

    it('user releases an unsaved provider creation when leaving settings with the add dialog open', async () => {
        const wrapper = await mount(AiServicesSection, { attachTo: document.body });
        await flushPromises();
        await wrapper.get('[data-testid="settings-add-custom-provider-button"]').trigger('click');
        await flushPromises();
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
            'Add custom provider'
        );
        expect(starts()).toHaveLength(1);

        wrapper.unmount();
        await flushPromises();
        expect(writes).toEqual([]);
        expect(completions()).toEqual([]);
        expect(telemetry.released).toEqual(['operation-1']);
    });
});
