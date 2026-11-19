import type { DatabaseQueryRequest } from '@services/NativeService/database';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, disposePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'vue-sonner';

import { setLocale } from '@/i18n';
import DataManagement from '@/views/SettingsView/components/DataManagement/index.vue';

import { getTauriInvokeCalls, mockTauriCommand } from '../utils/tauri';

let wrapper: VueWrapper | undefined;
let pinia: ReturnType<typeof createPinia>;

function clickButton(container: ParentNode, text: string) {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === text
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
    mockTauriCommand('storage_scan', () => ({
        categories: [],
        totalBytes: 0,
        reclaimableBytes: 0,
        databaseFreeBytes: 0,
        warnings: [],
        busy: false,
    }));
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

describe('given history controls are shown alongside storage maintenance', () => {
    beforeEach(() => {
        mockTauriCommand('database_query', (payload: unknown) => {
            const { request } = payload as { request: DatabaseQueryRequest };
            return {
                rows: request.sql.includes('count(') ? [{ count: 3 }] : [],
                rowsAffected: 0,
                lastInsertId: null,
            };
        });
    });

    it('user sees history and backup actions disabled while storage is busy and can refresh to recover', async () => {
        mockTauriCommand('storage_scan', () => ({
            categories: [],
            totalBytes: 0,
            reclaimableBytes: 0,
            databaseFreeBytes: 0,
            warnings: [],
            busy: true,
        }));
        const view = await openDataManagement();
        for (const target of [
            'data-clear-sessions',
            'data-clear-messages',
            'data-clear-turns',
            'export-settings',
            'import-settings',
        ]) {
            expect(
                view.get<HTMLButtonElement>(`[data-settings-search-target="${target}"] button`)
                    .element.disabled
            ).toBe(true);
        }

        mockTauriCommand('storage_scan', () => ({
            categories: [],
            totalBytes: 0,
            reclaimableBytes: 0,
            databaseFreeBytes: 0,
            warnings: [],
            busy: false,
        }));
        clickButton(view.element, 'Refresh');
        await flushPromises();

        expect(
            view.get<HTMLButtonElement>(
                '[data-settings-search-target="data-clear-sessions"] button'
            ).element.disabled
        ).toBe(false);
    });

    it('user sees deleted history counts and a reclaim warning when file cleanup fails after deletion committed', async () => {
        const warning = vi.spyOn(toast, 'warning');
        const view = await openDataManagement();
        mockTauriCommand('storage_clear_history', () => {
            mockTauriCommand('database_query', (payload: unknown) => {
                const { request } = payload as { request: DatabaseQueryRequest };
                return {
                    rows: request.sql.includes('count(') ? [{ count: 0 }] : [],
                    rowsAffected: 0,
                    lastInsertId: null,
                };
            });
            throw 'storage_history_committed:storage_io_failed';
        });
        await view
            .get('[data-settings-search-target="data-clear-sessions"] button')
            .trigger('click');
        await flushPromises();
        clickButton(document.querySelector('[role=alertdialog]')!, 'Confirm');
        await flushPromises();
        expect(
            view.get<HTMLButtonElement>(
                '[data-settings-search-target="data-clear-sessions"] button'
            ).element.disabled
        ).toBe(true);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining('History was deleted, but some files could not be reclaimed'),
            { duration: 3000 }
        );
        warning.mockRestore();
    });

    it.each([
        ['conversation sessions', 'data-clear-sessions'],
        ['messages', 'data-clear-messages'],
        ['conversation records', 'data-clear-turns'],
    ])(
        'user cancels the %s history action and no native data mutation starts',
        async (_label, target) => {
            const view = await openDataManagement();
            await view.get(`[data-settings-search-target="${target}"] button`).trigger('click');
            await flushPromises();
            const requests = getTauriInvokeCalls();
            const dialog = document.querySelector('[role=alertdialog]')!;
            expect(dialog).not.toBeNull();

            clickButton(dialog, 'Cancel');
            await flushPromises();

            expect(getTauriInvokeCalls()).toEqual(requests);
            expect(
                view.get<HTMLButtonElement>(`[data-settings-search-target="${target}"] button`)
                    .element.disabled
            ).toBe(false);
        }
    );

    it.each([
        ['conversation sessions', 'data-clear-sessions'],
        ['messages', 'data-clear-messages'],
        ['conversation records', 'data-clear-turns'],
    ])(
        'user confirms the %s history action then immediately leaves and no detached deletion starts',
        async (_label, target) => {
            const view = await openDataManagement();
            await view.get(`[data-settings-search-target="${target}"] button`).trigger('click');
            await flushPromises();
            const requests = getTauriInvokeCalls();
            const dialog = document.querySelector('[role=alertdialog]')!;
            expect(dialog).not.toBeNull();

            clickButton(dialog, 'Confirm');
            view.unmount();
            wrapper = undefined;
            await flushPromises();

            expect(document.querySelector('[role=alertdialog]')).toBeNull();
            expect(getTauriInvokeCalls()).toEqual(requests);
        }
    );
});

describe('user opens and closes data-management dialogs', () => {
    it.each(['settings_only', 'chat_only'] as const)(
        'user opens a %s archive and can restore only its available content',
        async (mode) => {
            mockTauriCommand('plugin:dialog|open', 'fixture.zip');
            mockTauriCommand('database_backup_scope', mode);
            mockTauriCommand('database_import_backup', () => {
                throw 'storage_busy';
            });
            const view = await openDataManagement();
            clickButton(view.element, 'Import');
            await flushPromises();
            const dialog = document.querySelector('[role=dialog]')!;
            const switches = [...dialog.querySelectorAll<HTMLButtonElement>('[role=switch]')];
            expect(switches.map((control) => control.disabled)).toEqual([
                mode === 'chat_only',
                mode === 'settings_only',
            ]);
            const enabled = switches.find((control) => !control.disabled)!;
            enabled.click();
            await flushPromises();
            const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
                (button) => button.textContent?.trim() === 'Import'
            )!;
            expect(confirm.disabled).toBe(true);
            enabled.click();
            await flushPromises();
            confirm.click();
            await flushPromises();
            expect(
                getTauriInvokeCalls('database_import_backup').map((call) => call.payload)
            ).toEqual([
                {
                    request: { sourcePath: 'fixture.zip', mode },
                },
            ]);
        }
    );

    it('user reopens import choices before an old exit and the new choices remain available', async () => {
        mockTauriCommand('plugin:dialog|open', 'fixture.db');
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

        clickButton(document.querySelector('[role=dialog]')!, 'Export');
        await flushPromises();

        expect(document.querySelector('[data-testid=progress-message]')).toBeNull();
        expect(getTauriInvokeCalls('database_export_backup')).toEqual([]);
    });

    it('user restarts to apply restored data with a warning when only post-commit cleanup failed', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        try {
            mockTauriCommand('plugin:dialog|open', 'D:/backups/full.zip');
            mockTauriCommand('database_backup_scope', 'full');
            mockTauriCommand('database_import_backup', () => {
                throw 'database_import_committed:temporary cleanup failed';
            });
            mockTauriCommand('plugin:process|restart', undefined);
            const view = await openDataManagement();
            const warning = vi.spyOn(toast, 'warning');
            clickButton(view.element, 'Import');
            await flushPromises();
            clickButton(document.querySelector('[role=dialog]')!, 'Import');
            await flushPromises();
            expect(warning).toHaveBeenCalledWith(
                expect.stringContaining(
                    'Data was restored, but some temporary files could not be cleaned up'
                ),
                { duration: 3000 }
            );
            warning.mockRestore();
            await vi.advanceTimersByTimeAsync(4000);
            expect(getTauriInvokeCalls('plugin:process|restart')).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
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
        clickButton(document.querySelector('[role=dialog]')!, 'Export');
        await flushPromises();
        expect(document.querySelector('[data-testid=progress-message]')).not.toBeNull();
        completions.shift()!();
        await flushPromises();

        clickButton(view.element, 'Export');
        await flushPromises();
        clickButton(document.querySelector('[role=dialog]')!, 'Export');
        await flushPromises();
        emitOldExit(
            document.querySelector('[data-testid=progress-message]')!.closest('[role=dialog]')!
        );
        await flushPromises();

        expect(document.querySelector('[data-testid=progress-message]')).not.toBeNull();
        completions.shift()!();
        await flushPromises();
        expect(document.querySelector('[data-testid=progress-message]')).toBeNull();
        expect(getTauriInvokeCalls('database_export_backup')).toHaveLength(2);
    });
});
