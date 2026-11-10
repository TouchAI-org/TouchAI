import type { DatabaseQueryRequest } from '@services/NativeService/database';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, disposePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import DataManagement from '@/views/SettingsView/components/DataManagement/index.vue';

import { getTauriInvokeCalls, mockTauriCommand } from '../utils/tauri';

let wrapper: VueWrapper | undefined;
let pinia: ReturnType<typeof createPinia>;

function clickButton(container: ParentNode, text: string) {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (element) => element.textContent?.trim() === text
    );
    expect(button, `button ${text}`).toBeDefined();
    button!.click();
}

function emitOldExit(element: Element) {
    const event = new Event('animationend', { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: 't-modal-out' });
    element.dispatchEvent(event);
}

async function openDataManagement() {
    wrapper = mount(DataManagement, { attachTo: document.body, global: { plugins: [pinia] } });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    pinia = createPinia();
    setLocale('en-US');
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    mockTauriCommand('database_query', (payload: unknown) => {
        const { request } = payload as { request: DatabaseQueryRequest };
        return {
            rows: request.sql.includes('count(') ? [{ count: 0 }] : [],
            rowsAffected: 0,
            lastInsertId: null,
        };
    });
    mockTauriCommand('analytics_get_state', () => ({
        status: 'disabled',
        consentEpoch: 0,
        queueDepth: 0,
        pendingBytes: 0,
        buildEligible: false,
        transportReady: false,
    }));
    mockTauriCommand('obs_diagnostic_mode_status', () => ({ enabled: false, expiresAtMs: 0 }));
    mockTauriCommand('obs_preview_bundle', () => ({ files: [], totalBytes: 0, truncated: false }));
});

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    disposePinia(pinia);
    await flushPromises();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    setLocale('zh-CN');
});

describe('user opens and closes data-management dialogs', () => {
    it('user reopens import choices before an old exit and the new choices remain available', async () => {
        const view = await openDataManagement();
        clickButton(view.element, 'Import');
        await flushPromises();
        const previous = document.querySelector('[role=dialog]')!;
        expect(previous).not.toBeNull();
        clickButton(previous, 'Cancel');
        await flushPromises();

        clickButton(view.element, 'Import');
        await flushPromises();
        const current = document.querySelector('[role=dialog]')!;
        emitOldExit(current);
        await flushPromises();

        expect(document.querySelector('[role=dialog]')?.textContent).toContain('Cancel');
        expect(getTauriInvokeCalls('database_import_backup')).toEqual([]);
    });

    it('user cancels backup destination selection and no progress or export starts', async () => {
        mockTauriCommand('plugin:dialog|save', () => null);
        const view = await openDataManagement();

        clickButton(view.element, 'Export');
        await flushPromises();

        expect(document.querySelector('[data-testid=progress-message]')).toBeNull();
        expect(getTauriInvokeCalls('database_export_backup')).toEqual([]);
    });

    it('user exports twice and a previous exit cannot dismiss the current progress dialog', async () => {
        mockTauriCommand('plugin:dialog|save', () => 'test-backup.db');
        const completions: Array<() => void> = [];
        mockTauriCommand(
            'database_export_backup',
            () =>
                new Promise<void>((resolve) => {
                    completions.push(resolve);
                })
        );
        const view = await openDataManagement();
        clickButton(view.element, 'Export');
        await flushPromises();
        expect(document.querySelector('[data-testid=progress-message]')).not.toBeNull();
        completions.shift()!();
        await flushPromises();

        clickButton(view.element, 'Export');
        await flushPromises();
        emitOldExit(document.querySelector('[role=dialog]')!);
        await flushPromises();

        expect(document.querySelector('[data-testid=progress-message]')).not.toBeNull();
        completions.shift()!();
        await flushPromises();
        expect(document.querySelector('[data-testid=progress-message]')).toBeNull();
        expect(getTauriInvokeCalls('database_export_backup')).toHaveLength(2);
    });
});
