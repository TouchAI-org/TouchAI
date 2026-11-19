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

async function chooseHistoryAction(view: VueWrapper, target: string) {
    await view.get('[data-testid="settings-storage-cleanup"]').trigger('click');
    await flushPromises();
    document.querySelector<HTMLButtonElement>('[data-testid="storage-choice-database"]')!.click();
    await flushPromises();
    if (target === 'data-clear-sessions') return;
    document
        .querySelector<HTMLButtonElement>('[data-testid="storage-database-scope"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    const label = target === 'data-clear-messages' ? 'Clear all messages' : 'Clear call details';
    const choice = [...document.querySelectorAll<HTMLElement>('[role=option]')].find((option) =>
        option.textContent?.includes(label)
    );
    expect(choice).toBeDefined();
    choice!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await flushPromises();
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
        categories: [{ id: 'database', bytes: 1024, reclaimableBytes: 0, fileCount: 1 }],
        totalBytes: 1024,
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
    mockTauriCommand('storage_get_location', () => ({
        currentPath: 'C:/fixture',
        pendingPath: null,
        notice: null,
        previousPath: null,
    }));
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
        for (const target of ['storage-cleanup', 'export-settings', 'import-settings']) {
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
            view.get<HTMLButtonElement>('[data-settings-search-target="storage-cleanup"] button')
                .element.disabled
        ).toBe(false);
    });

    it('user clears history and sees the committed result with a file cleanup warning', async () => {
        const warning = vi.spyOn(toast, 'warning');
        const view = await openDataManagement();
        mockTauriCommand('storage_cleanup_selected', () => ({
            removedFiles: 1,
            releasedBytes: 0,
            pendingBytes: 0,
            failedFiles: 1,
            failures: [{ path: 'fixture/locked.png', code: 'storage_io_failed' }],
            summary: {
                categories: [],
                totalBytes: 0,
                reclaimableBytes: 0,
                databaseFreeBytes: 0,
                warnings: [],
                busy: false,
            },
        }));
        await chooseHistoryAction(view, 'data-clear-sessions');
        clickButton(document.querySelector('[role=dialog]')!, 'Delete selected');
        await flushPromises();
        expect(view.text()).toContain('Files removed: 1.');
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('Failed files: 1.'), {
            duration: 3000,
        });
        warning.mockRestore();
    });

    it.each([
        ['conversation sessions', 'data-clear-sessions'],
        ['messages', 'data-clear-messages'],
        ['call details', 'data-clear-turns'],
    ])(
        'user cancels the %s history action and no native data mutation starts',
        async (_label, target) => {
            const view = await openDataManagement();
            await chooseHistoryAction(view, target);
            const requests = getTauriInvokeCalls();
            const dialog = document.querySelector('[role=dialog]')!;
            expect(dialog).not.toBeNull();

            clickButton(dialog, 'Cancel');
            await flushPromises();

            expect(getTauriInvokeCalls()).toEqual(requests);
            expect(
                view.get<HTMLButtonElement>(
                    '[data-settings-search-target="storage-cleanup"] button'
                ).element.disabled
            ).toBe(false);
        }
    );

    it.each([
        ['conversation sessions', 'data-clear-sessions'],
        ['messages', 'data-clear-messages'],
        ['call details', 'data-clear-turns'],
    ])(
        'user selects the %s history action then leaves before confirmation and no detached deletion starts',
        async (_label, target) => {
            const view = await openDataManagement();
            await chooseHistoryAction(view, target);
            const requests = getTauriInvokeCalls();
            const dialog = document.querySelector('[role=dialog]')!;
            expect(dialog).not.toBeNull();

            view.unmount();
            wrapper = undefined;
            clickButton(dialog, 'Delete selected');
            await flushPromises();

            expect(document.querySelector('[role=dialog]')).toBeNull();
            expect(getTauriInvokeCalls()).toEqual(requests);
        }
    );

    it.each([
        ['data-clear-sessions', 'sessions'],
        ['data-clear-messages', 'messages'],
        ['data-clear-turns', 'turns'],
    ])(
        'user chooses %s and confirms then only the selected history scope is cleared',
        async (target, kind) => {
            mockTauriCommand('storage_cleanup_selected', () => ({
                removedFiles: 0,
                releasedBytes: 0,
                pendingBytes: 0,
                failedFiles: 0,
                failures: [],
                summary: {
                    categories: [],
                    totalBytes: 0,
                    reclaimableBytes: 0,
                    databaseFreeBytes: 0,
                    warnings: [],
                    busy: false,
                },
            }));
            const view = await openDataManagement();
            await chooseHistoryAction(view, target);
            expect(getTauriInvokeCalls('storage_cleanup_selected')).toEqual([]);
            clickButton(document.querySelector('[role=dialog]')!, 'Delete selected');
            await flushPromises();
            expect(
                getTauriInvokeCalls('storage_cleanup_selected').map((call) => call.payload)
            ).toEqual([{ selection: { unused: false, categories: ['database'], history: kind } }]);
        }
    );

    it('user chooses call details and sees that messages and daily totals are retained', async () => {
        const view = await openDataManagement();
        await chooseHistoryAction(view, 'data-clear-turns');
        expect(
            document.querySelector('#storage-choice-database-description')?.textContent
        ).toContain('keep messages and daily usage totals');
    });
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
