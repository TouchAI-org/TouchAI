import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'vue-sonner';

import { setLocale } from '@/i18n';
import type {
    StorageCategory,
    StorageCleanupResult,
    StorageCompactionResult,
    StorageSummary,
} from '@/services/NativeService/storage';
import StorageSection from '@/views/SettingsView/components/DataManagement/components/StorageSection.vue';

import { getLastTauriInvokeCall, getTauriInvokeCalls, mockTauriCommand } from '../utils/tauri';

const MIB = 1024 * 1024;
const SAFE_CATEGORIES: StorageCategory[] = ['attachments', 'clipboard', 'thumbnails', 'temporary'];
const ACTIONS = ['cleanup', 'compact', 'recordings', 'logs'] as const;

function usage(patch: Partial<StorageSummary> = {}): StorageSummary {
    return {
        categories: [
            { id: 'attachments', bytes: 8 * MIB, reclaimableBytes: 2 * MIB, fileCount: 4 },
            { id: 'clipboard', bytes: 4 * MIB, reclaimableBytes: MIB, fileCount: 2 },
            { id: 'thumbnails', bytes: 2 * MIB, reclaimableBytes: MIB, fileCount: 8 },
            { id: 'temporary', bytes: 2 * MIB, reclaimableBytes: 2 * MIB, fileCount: 1 },
            { id: 'recordings', bytes: 20 * MIB, reclaimableBytes: 0, fileCount: 2 },
            { id: 'logs', bytes: 10 * MIB, reclaimableBytes: 0, fileCount: 5 },
            { id: 'database', bytes: 8 * MIB, reclaimableBytes: 0, fileCount: 1 },
            { id: 'assets', bytes: 30 * MIB, reclaimableBytes: 0, fileCount: 4 },
            { id: 'browser', bytes: 40 * MIB, reclaimableBytes: 0, fileCount: 5 },
        ],
        totalBytes: 124 * MIB,
        reclaimableBytes: 6 * MIB,
        databaseFreeBytes: 2 * MIB,
        warnings: [],
        busy: false,
        ...patch,
    };
}

function cleanupResult(patch: Partial<StorageCleanupResult> = {}): StorageCleanupResult {
    return {
        removedFiles: 3,
        releasedBytes: 2 * MIB,
        pendingBytes: 0,
        failedFiles: 0,
        failures: [],
        summary: usage({
            totalBytes: 122 * MIB,
            reclaimableBytes: 4 * MIB,
            categories: usage().categories.map((category) =>
                category.id === 'temporary'
                    ? { ...category, bytes: 0, reclaimableBytes: 0, fileCount: 0 }
                    : category
            ),
        }),
        ...patch,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

let wrapper: VueWrapper | undefined;
let host: HTMLDivElement;

async function openStorage(disabled = false) {
    wrapper = mount(StorageSection, { attachTo: host, props: { disabled } });
    await flushPromises();
    return wrapper;
}

function action(view: VueWrapper, name: (typeof ACTIONS)[number] | 'refresh') {
    return view.get<HTMLButtonElement>(`[data-testid="settings-storage-${name}"]`);
}

function confirmation() {
    const dialog = document.querySelector<HTMLElement>('[role=alertdialog]');
    expect(dialog).not.toBeNull();
    return dialog!;
}

function chooseConfirmation(text: string) {
    const button = [...confirmation().querySelectorAll<HTMLButtonElement>('button')].find(
        (element) => element.textContent?.trim() === text
    );
    expect(button, `confirmation action ${text}`).toBeDefined();
    button!.click();
}

beforeEach(() => {
    vi.useFakeTimers();
    setLocale('en-US');
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    host = document.createElement('div');
    document.body.appendChild(host);
    mockTauriCommand('storage_scan', () => usage());
    mockTauriCommand('storage_cleanup', () => cleanupResult());
    mockTauriCommand('storage_compact_database', () => ({
        beforeBytes: 8 * MIB,
        afterBytes: 6 * MIB,
        releasedBytes: 2 * MIB,
    }));
});

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    host.remove();
    toast.dismiss();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setLocale('zh-CN');
});

describe('given managed storage contains both unused files and retained user data', () => {
    it('user opens storage settings and sees native physical totals and every category', async () => {
        mockTauriCommand('storage_scan', () => usage({ totalBytes: 100 * MIB }));
        const view = await openStorage();

        expect(view.get('[data-testid="settings-storage-total"]').text()).toContain('100 MiB');
        for (const label of [
            'Attachments',
            'Clipboard copies',
            'Thumbnails',
            'Temporary files',
            'Recordings',
            'Logs',
            'Database',
            'Installed assets',
            'Browser data',
        ]) {
            expect(view.text()).toContain(label);
        }
        expect(view.get('[data-testid="settings-storage-category-attachments"]').text()).toContain(
            '8 MiB'
        );
        expect(view.get('[data-testid="settings-storage-category-browser"]').text()).toContain(
            '40 MiB'
        );
    });

    it('user refreshes usage and sees the latest scan instead of the previous totals', async () => {
        const view = await openStorage();
        mockTauriCommand('storage_scan', () => usage({ totalBytes: 80 * MIB }));

        await action(view, 'refresh').trigger('click');
        await flushPromises();

        expect(view.get('[data-testid="settings-storage-total"]').text()).toContain('80 MiB');
    });

    it('user confirms safe cleanup and only unused safe categories reach the native boundary', async () => {
        mockTauriCommand('storage_scan', () =>
            usage({
                reclaimableBytes: 36 * MIB,
                categories: usage().categories.map((category) =>
                    category.id === 'recordings' || category.id === 'logs'
                        ? { ...category, reclaimableBytes: category.bytes }
                        : category
                ),
            })
        );
        const view = await openStorage();

        await action(view, 'cleanup').trigger('click');
        await flushPromises();

        expect(confirmation().textContent).toContain('6 MiB');
        expect(confirmation().textContent).not.toContain('36 MiB');
        expect(confirmation().textContent).toContain(
            'Original files, recordings, logs, installed assets and browser data are kept.'
        );
        expect(getTauriInvokeCalls('storage_cleanup')).toEqual([]);
        for (const name of ACTIONS) expect(action(view, name).element.disabled).toBe(true);
        expect(action(view, 'refresh').element.disabled).toBe(true);

        chooseConfirmation('Clean up');
        await flushPromises();

        const cleanupRequest = getLastTauriInvokeCall('storage_cleanup');
        expect(cleanupRequest).toBeDefined();
        const requestedCategories = (
            cleanupRequest?.payload as { categories?: StorageCategory[] } | undefined
        )?.categories;
        expect(new Set(requestedCategories ?? SAFE_CATEGORIES)).toEqual(new Set(SAFE_CATEGORIES));
        expect(view.get('[data-testid="settings-storage-result"]').text()).toContain(
            'Files removed: 3. Observed release: 2 MiB. Estimated pending release: 0 B. Failed files: 0.'
        );
        expect(view.get('[data-testid="settings-storage-total"]').text()).toContain('122 MiB');
    });

    it('user cancels safe cleanup and no files are deleted', async () => {
        const view = await openStorage();
        await action(view, 'cleanup').trigger('click');
        await flushPromises();

        chooseConfirmation('Cancel');
        await flushPromises();

        expect(getTauriInvokeCalls('storage_cleanup')).toEqual([]);
        expect(view.find('[data-testid="settings-storage-result"]').exists()).toBe(false);
        expect(action(view, 'cleanup').element.disabled).toBe(false);
    });

    it.each([
        ['recordings', 'Delete recordings', '20 MiB'],
        ['logs', 'Delete logs', '10 MiB'],
    ] as const)(
        'user requests deletion of managed %s and must separately confirm that category',
        async (category, confirmText, estimate) => {
            const view = await openStorage();
            await action(view, category).trigger('click');
            await flushPromises();

            expect(confirmation().textContent).toContain(confirmText);
            expect(confirmation().textContent).toContain(estimate);
            expect(confirmation().textContent).toContain('default managed folder');
            expect(confirmation().textContent).toContain('cannot be undone');
            expect(confirmation().textContent).toContain('Custom folders');
            expect(getTauriInvokeCalls('storage_cleanup')).toEqual([]);

            chooseConfirmation(confirmText);
            await flushPromises();

            expect(getLastTauriInvokeCall('storage_cleanup')?.payload).toEqual({
                categories: [category],
            });
            expect(view.get('[data-testid="settings-storage-result"]').text()).toContain(
                'Observed release: 2 MiB'
            );
        }
    );

    it.each(['recordings', 'logs'] as const)(
        'user cancels deletion of managed %s and that category is retained',
        async (category) => {
            const view = await openStorage();
            await action(view, category).trigger('click');
            await flushPromises();

            chooseConfirmation('Cancel');
            await flushPromises();

            expect(getTauriInvokeCalls('storage_cleanup')).toEqual([]);
            expect(action(view, category).element.disabled).toBe(false);
        }
    );

    it('user explicitly deletes an empty managed log file even though it releases no bytes', async () => {
        mockTauriCommand('storage_scan', () =>
            usage({
                categories: usage().categories.map((category) =>
                    category.id === 'logs' ? { ...category, bytes: 0, fileCount: 1 } : category
                ),
            })
        );
        mockTauriCommand('storage_cleanup', () => cleanupResult({ releasedBytes: 0 }));
        const view = await openStorage();
        expect(action(view, 'logs').element.disabled).toBe(false);
        await action(view, 'logs').trigger('click');
        await flushPromises();

        expect(confirmation().textContent).toContain('0 B');
        chooseConfirmation('Delete logs');
        await flushPromises();

        expect(getLastTauriInvokeCall('storage_cleanup')?.payload).toEqual({
            categories: ['logs'],
        });
        expect(view.get('[data-testid="settings-storage-result"]').text()).toContain(
            'Observed release: 0 B'
        );
    });

    it('user confirms database compaction and sees actual before and after sizes', async () => {
        mockTauriCommand('storage_compact_database', () => ({
            beforeBytes: 8 * MIB,
            afterBytes: 7 * MIB,
            releasedBytes: MIB,
        }));
        const view = await openStorage();
        await action(view, 'compact').trigger('click');
        await flushPromises();

        expect(confirmation().textContent).toContain('2 MiB');
        expect(confirmation().textContent).toContain('Conversations and settings are kept.');
        expect(getTauriInvokeCalls('storage_compact_database')).toEqual([]);

        mockTauriCommand('storage_scan', () =>
            usage({
                totalBytes: 123 * MIB,
                databaseFreeBytes: 0,
                categories: usage().categories.map((category) =>
                    category.id === 'database' ? { ...category, bytes: 7 * MIB } : category
                ),
            })
        );
        chooseConfirmation('Compact');
        await flushPromises();

        expect(getLastTauriInvokeCall('storage_compact_database')).toBeDefined();
        expect(view.get('[data-testid="settings-storage-result"]').text()).toContain(
            'Database size: 8 MiB to 7 MiB. Released 1 MiB.'
        );
        expect(view.get('[data-testid="settings-storage-category-database"]').text()).toContain(
            '7 MiB'
        );
        expect(action(view, 'compact').element.disabled).toBe(true);
    });

    it('user cancels database compaction and the database is not rebuilt', async () => {
        const view = await openStorage();
        await action(view, 'compact').trigger('click');
        await flushPromises();

        chooseConfirmation('Cancel');
        await flushPromises();

        expect(getTauriInvokeCalls('storage_compact_database')).toEqual([]);
        expect(action(view, 'compact').element.disabled).toBe(false);
    });
});

describe('given storage cannot be changed safely yet', () => {
    it('user waits for a scan and sees loading with maintenance actions disabled', async () => {
        const scan = deferred<StorageSummary>();
        mockTauriCommand('storage_scan', () => scan.promise);
        const view = await openStorage();

        expect(view.text()).toContain('Scanning storage...');
        expect(action(view, 'refresh').element.disabled).toBe(true);
        for (const name of ACTIONS) expect(action(view, name).element.disabled).toBe(true);

        scan.resolve(usage());
        await flushPromises();

        expect(view.text()).not.toContain('Scanning storage...');
        expect(action(view, 'cleanup').element.disabled).toBe(false);
    });

    it('user sees busy maintenance actions disabled and can refresh after work finishes', async () => {
        mockTauriCommand('storage_scan', () => usage({ busy: true }));
        const view = await openStorage();

        expect(view.text()).toContain('Storage is in use.');
        for (const name of ACTIONS) {
            expect(action(view, name).element.disabled).toBe(true);
            await action(view, name).trigger('click');
        }
        expect(getTauriInvokeCalls('storage_cleanup')).toEqual([]);
        expect(getTauriInvokeCalls('storage_compact_database')).toEqual([]);
        expect(document.querySelector('[role=alertdialog]')).toBeNull();
        expect(action(view, 'refresh').element.disabled).toBe(false);

        mockTauriCommand('storage_scan', () => usage());
        await action(view, 'refresh').trigger('click');
        await flushPromises();

        expect(view.text()).not.toContain('Storage is in use.');
        expect(action(view, 'cleanup').element.disabled).toBe(false);
    });

    it('user sees no reclaimable files and cannot start empty maintenance actions', async () => {
        mockTauriCommand('storage_scan', () =>
            usage({
                categories: usage().categories.map((category) => ({
                    ...category,
                    bytes: 0,
                    reclaimableBytes: 0,
                    fileCount: 0,
                })),
                totalBytes: 0,
                reclaimableBytes: 0,
                databaseFreeBytes: 0,
            })
        );
        const view = await openStorage();

        expect(view.text()).toContain('No reclaimable files');
        expect(view.get('[data-testid="settings-storage-total"]').text()).toContain('0 B');
        for (const name of ACTIONS) expect(action(view, name).element.disabled).toBe(true);
        expect(action(view, 'refresh').element.disabled).toBe(false);
    });

    it('user has only retained recordings and logs and safe cleanup does not select them', async () => {
        mockTauriCommand('storage_scan', () =>
            usage({
                categories: usage().categories.map((category) => ({
                    ...category,
                    reclaimableBytes: 0,
                })),
                reclaimableBytes: 0,
            })
        );
        const view = await openStorage();

        expect(action(view, 'cleanup').element.disabled).toBe(true);
        expect(action(view, 'recordings').element.disabled).toBe(false);
        expect(action(view, 'logs').element.disabled).toBe(false);
        expect(getTauriInvokeCalls('storage_cleanup')).toEqual([]);
    });

    it('user sees an incomplete scan warning and must refresh before maintenance', async () => {
        mockTauriCommand('storage_scan', () => usage({ warnings: ['storage_scan_incomplete'] }));
        const view = await openStorage();

        expect(view.text()).toContain('The storage scan is incomplete.');
        for (const name of ACTIONS) expect(action(view, name).element.disabled).toBe(true);
        expect(action(view, 'refresh').element.disabled).toBe(false);
    });

    it('user sees a bounded warning list but cannot maintain storage when a later warning reports an incomplete scan', async () => {
        mockTauriCommand('storage_scan', () =>
            usage({
                warnings: [
                    'first',
                    'second',
                    'third',
                    'fourth',
                    'fifth',
                    'storage_scan_incomplete',
                ],
            })
        );
        const view = await openStorage();

        expect(view.text()).toContain('1 more warning');
        for (const name of ACTIONS) expect(action(view, name).element.disabled).toBe(true);
    });

    it('user sees a scan error and can recover by refreshing', async () => {
        mockTauriCommand('storage_scan', () => Promise.reject('unexpected scan failure'));
        const view = await openStorage();

        expect(view.get('[data-testid="settings-storage-error"]').text()).toBe(
            'Could not scan storage. Refresh to try again.'
        );
        for (const name of ACTIONS) expect(action(view, name).element.disabled).toBe(true);

        mockTauriCommand('storage_scan', () => usage());
        await action(view, 'refresh').trigger('click');
        await flushPromises();

        expect(view.find('[data-testid="settings-storage-error"]').exists()).toBe(false);
        expect(action(view, 'cleanup').element.disabled).toBe(false);
    });

    it('user scans an attachment that fails verification and sees a refusal without deleting anything', async () => {
        mockTauriCommand('storage_scan', () =>
            Promise.reject(new Error('storage_corrupt_attachment'))
        );
        const view = await openStorage();

        expect(view.get('[data-testid="settings-storage-error"]').text()).toContain(
            'An attachment failed verification.'
        );
        expect(action(view, 'cleanup').element.disabled).toBe(true);
        expect(getTauriInvokeCalls('storage_cleanup')).toEqual([]);
    });

    it('user starts cleanup while storage becomes busy and gets a recoverable refusal', async () => {
        mockTauriCommand('storage_cleanup', () =>
            Promise.reject({ code: 'storage_busy', message: 'maintenance gate held' })
        );
        const view = await openStorage();
        await action(view, 'cleanup').trigger('click');
        await flushPromises();
        chooseConfirmation('Clean up');
        await flushPromises();

        expect(view.get('[data-testid="settings-storage-error"]').text()).toContain(
            'Storage is in use.'
        );
        expect(view.find('[data-testid="settings-storage-result"]').exists()).toBe(false);
        expect(action(view, 'cleanup').element.disabled).toBe(true);

        await action(view, 'refresh').trigger('click');
        await flushPromises();

        expect(view.find('[data-testid="settings-storage-error"]').exists()).toBe(false);
        expect(action(view, 'cleanup').element.disabled).toBe(false);
    });

    it('user is refused database compaction without enough disk space and keeps existing usage', async () => {
        mockTauriCommand('storage_compact_database', () =>
            Promise.reject('storage_insufficient_space')
        );
        const view = await openStorage();
        await action(view, 'compact').trigger('click');
        await flushPromises();
        chooseConfirmation('Compact');
        await flushPromises();

        expect(view.get('[data-testid="settings-storage-error"]').text()).toContain(
            'Not enough free disk space.'
        );
        expect(view.get('[data-testid="settings-storage-total"]').text()).toContain('124 MiB');
        expect(view.find('[data-testid="settings-storage-result"]').exists()).toBe(false);
        expect(action(view, 'refresh').element.disabled).toBe(false);
    });

    it('user starts a backup elsewhere and storage actions remain disabled until it finishes', async () => {
        const view = await openStorage();
        await view.setProps({ disabled: true });

        for (const name of [...ACTIONS, 'refresh'] as const) {
            expect(action(view, name).element.disabled).toBe(true);
        }

        await view.setProps({ disabled: false });
        expect(action(view, 'cleanup').element.disabled).toBe(false);
    });

    it('user confirms after another data operation starts and no cleanup is submitted', async () => {
        const view = await openStorage();
        await action(view, 'cleanup').trigger('click');
        await flushPromises();
        await view.setProps({ disabled: true });

        chooseConfirmation('Clean up');
        await flushPromises();

        expect(getTauriInvokeCalls('storage_cleanup')).toEqual([]);
        await view.setProps({ disabled: false });
        expect(action(view, 'cleanup').element.disabled).toBe(false);
    });
});

describe('given some storage files cannot be released immediately', () => {
    it('user completes partial cleanup and sees released, pending and failed amounts separately', async () => {
        mockTauriCommand('storage_cleanup', () =>
            cleanupResult({
                pendingBytes: MIB,
                failedFiles: 1,
                failures: [
                    { path: 'C:\\TouchAI\\temporary\\locked.tmp', code: 'storage_io_failed' },
                ],
            })
        );
        const view = await openStorage();
        await action(view, 'cleanup').trigger('click');
        await flushPromises();
        chooseConfirmation('Clean up');
        await flushPromises();

        expect(view.get('[data-testid="settings-storage-result"]').text()).toContain(
            'Files removed: 3. Observed release: 2 MiB. Estimated pending release: 1 MiB. Failed files: 1.'
        );
        expect(view.get('details').text()).toContain('C:\\TouchAI\\temporary\\locked.tmp');
        expect(view.get('details').text()).toContain(
            'Some storage files could not be read or removed.'
        );
        expect(view.get('[data-testid="settings-storage-total"]').text()).toContain('122 MiB');
        expect(action(view, 'cleanup').element.disabled).toBe(false);
    });

    it('user completes cleanup with no physical release and does not see the estimate reported as savings', async () => {
        mockTauriCommand('storage_cleanup', () =>
            cleanupResult({ releasedBytes: 0, pendingBytes: 2 * MIB, summary: usage() })
        );
        const view = await openStorage();
        await action(view, 'cleanup').trigger('click');
        await flushPromises();
        chooseConfirmation('Clean up');
        await flushPromises();

        expect(view.get('[data-testid="settings-storage-result"]').text()).toContain(
            'Observed release: 0 B. Estimated pending release: 2 MiB.'
        );
        expect(view.get('[data-testid="settings-storage-result"]').text()).not.toContain(
            'Released 6 MiB'
        );
    });

    it('user sees bounded failure details as plain data instead of executable markup', async () => {
        mockTauriCommand('storage_cleanup', () =>
            cleanupResult({
                failedFiles: 7,
                failures: Array.from({ length: 7 }, (_, index) => ({
                    path: index === 0 ? '<script>unsafe-file-name</script>' : `failed-${index}.tmp`,
                    code: 'storage_io_failed',
                })),
            })
        );
        const view = await openStorage();
        await action(view, 'cleanup').trigger('click');
        await flushPromises();
        chooseConfirmation('Clean up');
        await flushPromises();

        expect(view.get('details').text()).toContain('<script>unsafe-file-name</script>');
        expect(view.get('details').find('script').exists()).toBe(false);
        expect(view.get('details').text()).toContain('2 more failures');
        expect(view.get('details').text()).not.toContain('failed-6.tmp');
    });

    it('user finishes compaction but a failed refresh does not hide the successful result', async () => {
        const view = await openStorage();
        await action(view, 'compact').trigger('click');
        await flushPromises();
        mockTauriCommand('storage_scan', () => Promise.reject('storage_io_failed'));

        chooseConfirmation('Compact');
        await flushPromises();

        expect(view.get('[data-testid="settings-storage-result"]').text()).toContain(
            'Database size: 8 MiB to 6 MiB. Released 2 MiB.'
        );
        expect(view.get('[data-testid="settings-storage-error"]').text()).toContain(
            'Some storage files could not be read or removed.'
        );
        expect(action(view, 'compact').element.disabled).toBe(true);
    });
});

describe('given the user leaves storage settings during an asynchronous action', () => {
    it('user leaves with a confirmation open and no detached deletion can start', async () => {
        const view = await openStorage();
        await action(view, 'recordings').trigger('click');
        await flushPromises();
        expect(confirmation()).not.toBeNull();

        view.unmount();
        wrapper = undefined;
        await flushPromises();

        expect(document.querySelector('[role=alertdialog]')).toBeNull();
        expect(getTauriInvokeCalls('storage_cleanup')).toEqual([]);
    });

    it('user confirms and immediately leaves before deletion starts and no files are removed', async () => {
        const view = await openStorage();
        await action(view, 'cleanup').trigger('click');
        await flushPromises();

        chooseConfirmation('Clean up');
        view.unmount();
        wrapper = undefined;
        await flushPromises();

        expect(document.querySelector('[role=alertdialog]')).toBeNull();
        expect(getTauriInvokeCalls('storage_cleanup')).toEqual([]);
    });

    it('user leaves during a scan and a late failure produces no detached notification', async () => {
        const scan = deferred<StorageSummary>();
        mockTauriCommand('storage_scan', () => scan.promise);
        const view = await openStorage();

        view.unmount();
        wrapper = undefined;
        scan.reject('storage_io_failed');
        await flushPromises();

        expect(document.querySelector('[data-sonner-toast]')).toBeNull();
        expect(document.querySelector('[data-testid="settings-storage-error"]')).toBeNull();
    });

    it('user leaves during cleanup and a late result cannot start background work or notify another page', async () => {
        const cleanup = deferred<StorageCleanupResult>();
        mockTauriCommand('storage_cleanup', () => cleanup.promise);
        const view = await openStorage();
        await action(view, 'cleanup').trigger('click');
        await flushPromises();
        chooseConfirmation('Clean up');
        await flushPromises();
        const scanRequests = getTauriInvokeCalls('storage_scan');

        view.unmount();
        wrapper = undefined;
        cleanup.resolve(cleanupResult({ failedFiles: 1 }));
        await flushPromises();

        expect(getTauriInvokeCalls('storage_scan')).toEqual(scanRequests);
        expect(document.querySelector('[data-sonner-toast]')).toBeNull();
    });

    it('user leaves during compaction and completion does not scan or show a detached success', async () => {
        const compaction = deferred<StorageCompactionResult>();
        mockTauriCommand('storage_compact_database', () => compaction.promise);
        const view = await openStorage();
        await action(view, 'compact').trigger('click');
        await flushPromises();
        chooseConfirmation('Compact');
        await flushPromises();
        const scanRequests = getTauriInvokeCalls('storage_scan');

        view.unmount();
        wrapper = undefined;
        compaction.resolve({ beforeBytes: 8 * MIB, afterBytes: 6 * MIB, releasedBytes: 2 * MIB });
        await flushPromises();

        expect(getTauriInvokeCalls('storage_scan')).toEqual(scanRequests);
        expect(document.querySelector('[data-sonner-toast]')).toBeNull();
    });

    it('user reopens storage while an old scan finishes and only the new usage is displayed', async () => {
        const oldScan = deferred<StorageSummary>();
        mockTauriCommand('storage_scan', () => oldScan.promise);
        const oldView = await openStorage();
        oldView.unmount();
        wrapper = undefined;
        mockTauriCommand('storage_scan', () => usage({ totalBytes: 50 * MIB }));
        const currentView = await openStorage();

        oldScan.resolve(usage({ totalBytes: 999 * MIB }));
        await flushPromises();

        expect(currentView.get('[data-testid="settings-storage-total"]').text()).toContain(
            '50 MiB'
        );
        expect(currentView.text()).not.toContain('999 MiB');
        expect(action(currentView, 'cleanup').element.disabled).toBe(false);
    });
});
