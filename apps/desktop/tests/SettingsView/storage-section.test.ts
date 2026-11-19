import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'vue-sonner';

import { setLocale } from '@/i18n';
import type { StorageCleanupResult, StorageSummary } from '@/services/NativeService/storage';
import StorageSection from '@/views/SettingsView/components/DataManagement/components/StorageSection.vue';

import { getLastTauriInvokeCall, getTauriInvokeCalls, mockTauriCommand } from '../utils/tauri';

const MIB = 1024 * 1024;

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

function result(patch: Partial<StorageCleanupResult> = {}): StorageCleanupResult {
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

async function openStorage() {
    wrapper = mount(StorageSection, { attachTo: host });
    await flushPromises();
    return wrapper;
}

function action(view: VueWrapper, name: 'cleanup' | 'refresh') {
    return view.get<HTMLButtonElement>(`[data-testid="settings-storage-${name}"]`);
}

function dialog() {
    const element = document.querySelector<HTMLElement>('[role=dialog]');
    expect(element).not.toBeNull();
    return element!;
}

function control(id: string) {
    const element = dialog().querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    expect(element, id).not.toBeNull();
    return element!;
}

async function openCleanup(view: VueWrapper) {
    await action(view, 'cleanup').trigger('click');
    await flushPromises();
}

async function confirm() {
    control('storage-cleanup-confirm').click();
    await flushPromises();
}

beforeEach(() => {
    vi.useFakeTimers();
    setLocale('en-US');
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    host = document.createElement('div');
    document.body.appendChild(host);
    mockTauriCommand('storage_scan', () => usage());
    mockTauriCommand('storage_cleanup_selected', () => result());
    mockTauriCommand('plugin:process|restart', undefined);
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

describe('given storage contains unused files and retained user data', () => {
    it('user opens the overview and selects any occupied category to read its usage and file count', async () => {
        const view = await openStorage();
        const chart = view.get('figure');
        expect(chart.get('[role=img]').attributes('aria-label')).toBe('Used space');
        expect(chart.text()).toContain('124 MiB');
        expect(chart.get('ul').findAll('li')).toHaveLength(9);
        expect(view.find('summary').exists()).toBe(false);
        const browser = chart.get('[data-testid=settings-storage-category-browser]');
        expect(browser.get('button').attributes('title')).toContain('5 files');
        expect(browser.text()).toContain('40 MiB');
        expect(browser.text()).not.toContain('32.3%');
        await chart
            .get('[data-testid=settings-storage-category-thumbnails] button')
            .trigger('click');
        expect(chart.get('svg + div').text()).toContain('Thumbnails');
        expect(chart.get('svg + div').text()).toContain('8 files');
        expect(chart.get('svg + div').text()).toContain('1.6%');
        expect(document.querySelector('[role=dialog]')).toBeNull();
    });

    it('user refreshes usage and sees the latest native totals', async () => {
        const view = await openStorage();
        mockTauriCommand('storage_scan', () => usage({ totalBytes: 80 * MIB }));
        await action(view, 'refresh').trigger('click');
        await flushPromises();
        expect(view.get('[data-testid=settings-storage-total]').text()).toContain('80 MiB');
    });

    it('user confirms the default unused selection and recovers files and database space in one action', async () => {
        const view = await openStorage();
        await openCleanup(view);
        expect(dialog().textContent).toContain('Up to 8 MiB');
        expect(control('storage-choice-unused').getAttribute('aria-checked')).toBe('true');
        for (const category of usage().categories)
            expect(control(`storage-choice-${category.id}`).getAttribute('aria-checked')).toBe(
                'false'
            );
        expect(getTauriInvokeCalls('storage_cleanup_selected')).toEqual([]);
        expect(action(view, 'refresh').element.disabled).toBe(true);
        await confirm();
        expect(getLastTauriInvokeCall('storage_cleanup_selected')?.payload).toEqual({
            selection: { unused: true, categories: [] },
        });
        expect(view.get('[data-testid=settings-storage-result]').text()).toContain(
            'Files removed: 3. Observed release: 2 MiB. Estimated pending release: 0 B. Failed files: 0.'
        );
        expect(view.emitted('cleaned')).toHaveLength(1);
    });

    it('user pins a category and sees the remaining total when cleanup empties it', async () => {
        const view = await openStorage();
        await view.get('[data-testid=settings-storage-category-temporary] button').trigger('click');
        await openCleanup(view);
        await confirm();
        await vi.advanceTimersByTimeAsync(1000);
        expect(view.get('figure svg + div').text()).toContain('122 MiB');
        expect(
            view.get('[data-testid=settings-storage-category-temporary] button').attributes('title')
        ).toContain('0 files');
    });

    it.each(['recordings', 'logs'] as const)(
        'user chooses %s and deletes only that selected category',
        async (category) => {
            const view = await openStorage();
            await openCleanup(view);
            control('storage-choice-unused').click();
            control(`storage-choice-${category}`).click();
            await flushPromises();
            expect(
                dialog().querySelector(`#storage-choice-${category}-description`)?.textContent
            ).toContain(
                category === 'recordings'
                    ? 'Saved operation recordings; deletion cannot be undone'
                    : 'App activity and crash records'
            );
            expect(control('storage-cleanup-confirm').textContent).toContain('Delete selected');
            await confirm();
            expect(getLastTauriInvokeCall('storage_cleanup_selected')?.payload).toEqual({
                selection: { unused: false, categories: [category] },
            });
        }
    );

    it('user selects all categories and sees an estimate without counting unused files twice', async () => {
        const view = await openStorage();
        await openCleanup(view);
        control('storage-choice-all').click();
        await flushPromises();
        expect(dialog().textContent).toContain('Up to 124 MiB');
        expect(control('storage-cleanup-confirm').textContent).toContain('Delete and restart');
        await confirm();
        const payload = getLastTauriInvokeCall('storage_cleanup_selected')?.payload as {
            selection: { unused: boolean; categories: string[] };
        };
        expect(payload.selection.unused).toBe(true);
        expect(new Set(payload.selection.categories)).toEqual(
            new Set(usage().categories.map((category) => category.id))
        );
    });

    it('user deselects all categories and returns to only unused files', async () => {
        await openCleanup(await openStorage());
        control('storage-choice-all').click();
        await flushPromises();
        control('storage-choice-all').click();
        await flushPromises();
        expect(dialog().textContent).toContain('Up to 8 MiB');
        expect(control('storage-cleanup-confirm').textContent).toContain('Clean up');
    });

    it('user cancels a destructive selection and reopening restores the unused default', async () => {
        const view = await openStorage();
        await openCleanup(view);
        control('storage-choice-database').click();
        control('storage-cleanup-cancel').click();
        await flushPromises();
        expect(getTauriInvokeCalls('storage_cleanup_selected')).toEqual([]);
        await openCleanup(view);
        expect(control('storage-choice-database').getAttribute('aria-checked')).toBe('false');
    });

    it('user deletes a zero-byte managed file even though it releases no bytes', async () => {
        mockTauriCommand('storage_scan', () =>
            usage({
                categories: usage().categories.map((category) =>
                    category.id === 'logs' ? { ...category, bytes: 0, fileCount: 1 } : category
                ),
            })
        );
        await openCleanup(await openStorage());
        expect(control('storage-choice-logs').disabled).toBe(false);
        control('storage-choice-unused').click();
        control('storage-choice-logs').click();
        await flushPromises();
        expect(dialog().textContent).toContain('Up to 0 B');
        await confirm();
        expect(getLastTauriInvokeCall('storage_cleanup_selected')?.payload).toEqual({
            selection: { unused: false, categories: ['logs'] },
        });
    });
});

describe('given storage cannot be changed yet', () => {
    it('user waits for the first scan before maintenance is available', async () => {
        const scan = deferred<StorageSummary>();
        mockTauriCommand('storage_scan', () => scan.promise);
        const view = await openStorage();
        expect(action(view, 'refresh').attributes('aria-label')).toBe('Scanning storage...');
        expect(view.find('[data-testid=settings-storage-cleanup]').exists()).toBe(false);
        scan.resolve(usage());
        await flushPromises();
        expect(action(view, 'cleanup').element.disabled).toBe(false);
    });

    it.each([
        { busy: true },
        { warnings: ['storage_scan_incomplete'] },
        { warnings: ['first', 'second', 'third', 'fourth', 'fifth', 'storage_scan_incomplete'] },
    ])(
        'user sees unavailable storage and can refresh after the blocker clears: %j',
        async (patch) => {
            mockTauriCommand('storage_scan', () => usage(patch));
            const view = await openStorage();
            expect(action(view, 'cleanup').element.disabled).toBe(true);
            if (patch.warnings?.length === 6) expect(view.text()).toContain('1 more warning');
            mockTauriCommand('storage_scan', () => usage());
            await action(view, 'refresh').trigger('click');
            await flushPromises();
            expect(action(view, 'cleanup').element.disabled).toBe(false);
        }
    );

    it('user sees an empty overview and cannot confirm an empty selection', async () => {
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
        expect(view.get('figure').find('circle').exists()).toBe(true);
        await openCleanup(view);
        expect(control('storage-choice-unused').disabled).toBe(true);
        expect(control('storage-choice-all').disabled).toBe(true);
        expect(control('storage-cleanup-confirm').disabled).toBe(true);
    });

    it('user has only retained files and must explicitly select them', async () => {
        mockTauriCommand('storage_scan', () =>
            usage({
                categories: usage().categories.map((category) => ({
                    ...category,
                    reclaimableBytes: 0,
                })),
                reclaimableBytes: 0,
                databaseFreeBytes: 0,
            })
        );
        await openCleanup(await openStorage());
        expect(control('storage-choice-unused').getAttribute('aria-checked')).toBe('false');
        expect(control('storage-cleanup-confirm').disabled).toBe(true);
        control('storage-choice-browser').click();
        await flushPromises();
        expect(control('storage-cleanup-confirm').disabled).toBe(false);
    });

    it.each([
        ['unexpected', 'Could not scan storage.'],
        [new Error('storage_corrupt_attachment'), 'An attachment failed verification.'],
    ])('user sees a failed scan and can recover by refreshing: %s', async (error, notice) => {
        mockTauriCommand('storage_scan', () => Promise.reject(error));
        const view = await openStorage();
        expect(view.get('[data-testid=settings-storage-error]').text()).toContain(notice);
        mockTauriCommand('storage_scan', () => usage());
        await action(view, 'refresh').trigger('click');
        await flushPromises();
        expect(view.find('[data-testid=settings-storage-error]').exists()).toBe(false);
    });

    it.each([
        [{ code: 'storage_busy' }, 'Storage is in use.'],
        ['storage_insufficient_space', 'Not enough free disk space.'],
        ['unexpected', 'Cleanup could not finish.'],
    ])(
        'user receives a cleanup refusal and retains the existing totals: %j',
        async (error, notice) => {
            mockTauriCommand('storage_cleanup_selected', () => Promise.reject(error));
            const view = await openStorage();
            await openCleanup(view);
            await confirm();
            expect(view.get('[data-testid=settings-storage-error]').text()).toContain(notice);
            expect(view.get('[data-testid=settings-storage-total]').text()).toContain('124 MiB');
            expect(action(view, 'cleanup').element.disabled).toBe(true);
            await action(view, 'refresh').trigger('click');
            await flushPromises();
            expect(action(view, 'cleanup').element.disabled).toBe(false);
        }
    );

    it('user starts another data operation and cannot confirm cleanup until it finishes', async () => {
        const view = await openStorage();
        await openCleanup(view);
        await view.setProps({ disabled: true });
        expect(control('storage-cleanup-confirm').disabled).toBe(true);
        await confirm();
        expect(getTauriInvokeCalls('storage_cleanup_selected')).toEqual([]);
        await view.setProps({ disabled: false });
        expect(control('storage-cleanup-confirm').disabled).toBe(false);
    });

    it('user confirms deletion once and cannot resubmit or close it while running', async () => {
        const cleanup = deferred<StorageCleanupResult>();
        mockTauriCommand('storage_cleanup_selected', () => cleanup.promise);
        await openCleanup(await openStorage());
        await confirm();
        expect(control('storage-cleanup-cancel').disabled).toBe(true);
        expect(control('storage-cleanup-confirm').disabled).toBe(true);
        await confirm();
        expect(getTauriInvokeCalls('storage_cleanup_selected')).toHaveLength(1);
        cleanup.resolve(result());
        await flushPromises();
    });
});

describe('given cleanup reports partial results or requires restart', () => {
    it('user sees partial deletion details before choosing to restart', async () => {
        mockTauriCommand('storage_cleanup_selected', () =>
            result({
                restartRequired: true,
                failedFiles: 1,
                failures: [{ path: 'managed/locked-font.woff2', code: 'storage_io_failed' }],
            })
        );
        const view = await openStorage();
        await openCleanup(view);
        await confirm();
        expect(getTauriInvokeCalls('plugin:process|restart')).toEqual([]);
        expect(view.get('[data-testid=settings-storage-failures]').text()).toContain(
            'managed/locked-font.woff2'
        );
        expect(view.findAll('button').find((button) => button.text() === 'Restart')).toBeDefined();
        expect(action(view, 'cleanup').element.disabled).toBe(true);
    });
    it('user completes partial cleanup and sees bounded failure details as plain text', async () => {
        mockTauriCommand('storage_cleanup_selected', () =>
            result({
                pendingBytes: MIB,
                failedFiles: 7,
                failures: Array.from({ length: 7 }, (_, index) => ({
                    path: index === 0 ? '<script>unsafe-file-name</script>' : `failed-${index}.tmp`,
                    code: 'storage_io_failed',
                })),
            })
        );
        const view = await openStorage();
        await openCleanup(view);
        await confirm();
        expect(view.get('[data-testid=settings-storage-result]').text()).toContain(
            'Estimated pending release: 1 MiB. Failed files: 7.'
        );
        const failures = view.get('[data-testid=settings-storage-failures]');
        expect(failures.text()).toContain('<script>unsafe-file-name</script>');
        expect(failures.find('script').exists()).toBe(false);
        expect(failures.text()).toContain('2 more failures');
        expect(failures.text()).not.toContain('failed-6.tmp');
        expect(action(view, 'cleanup').element.disabled).toBe(false);
    });

    it('user sees no observed release when files remain physically allocated', async () => {
        mockTauriCommand('storage_cleanup_selected', () =>
            result({ releasedBytes: 0, pendingBytes: 2 * MIB })
        );
        const view = await openStorage();
        await openCleanup(view);
        await confirm();
        expect(view.get('[data-testid=settings-storage-result]').text()).toContain(
            'Observed release: 0 B. Estimated pending release: 2 MiB.'
        );
    });

    it('user sees committed cleanup even when the final scan is incomplete', async () => {
        mockTauriCommand('storage_cleanup_selected', () =>
            result({ summary: usage({ warnings: ['storage_scan_incomplete'] }) })
        );
        const view = await openStorage();
        await openCleanup(view);
        await confirm();
        expect(view.get('[data-testid=settings-storage-result]').text()).toContain(
            'Files removed: 3.'
        );
        expect(view.text()).toContain('The storage scan is incomplete.');
        expect(action(view, 'cleanup').element.disabled).toBe(true);
    });

    it('user deletes database contents and the app restarts without reloading the closed database', async () => {
        mockTauriCommand('storage_cleanup_selected', () => result({ restartRequired: true }));
        const view = await openStorage();
        await openCleanup(view);
        control('storage-choice-database').click();
        await flushPromises();
        await confirm();
        expect(getTauriInvokeCalls('plugin:process|restart')).toHaveLength(1);
        expect(view.emitted('cleaned')).toBeUndefined();
        expect(action(view, 'refresh').element.disabled).toBe(true);
    });

    it('user cannot restart automatically and can retry restart while further changes stay disabled', async () => {
        mockTauriCommand('storage_cleanup_selected', () => result({ restartRequired: true }));
        mockTauriCommand('plugin:process|restart', () => Promise.reject('restart unavailable'));
        const view = await openStorage();
        await openCleanup(view);
        await confirm();
        expect(view.text()).toContain('Restart the app');
        expect(action(view, 'cleanup').element.disabled).toBe(true);
        const restart = view.findAll('button').find((button) => button.text() === 'Restart')!;
        expect(restart).toBeDefined();
        mockTauriCommand('plugin:process|restart', undefined);
        await restart.trigger('click');
        await flushPromises();
        expect(getTauriInvokeCalls('plugin:process|restart')).toHaveLength(2);
    });
});

describe('given the user leaves settings during an asynchronous operation', () => {
    it('user leaves with a selection open and no detached deletion starts', async () => {
        const view = await openStorage();
        await openCleanup(view);
        view.unmount();
        wrapper = undefined;
        await flushPromises();
        expect(document.querySelector('[role=dialog]')).toBeNull();
        expect(getTauriInvokeCalls('storage_cleanup_selected')).toEqual([]);
    });

    it('user leaves during a scan and a late failure does not notify another page', async () => {
        const scan = deferred<StorageSummary>();
        mockTauriCommand('storage_scan', () => scan.promise);
        const view = await openStorage();
        view.unmount();
        wrapper = undefined;
        scan.reject('storage_io_failed');
        await flushPromises();
        expect(document.querySelector('[data-sonner-toast]')).toBeNull();
    });

    it.each([false, true])(
        'user leaves after confirming and committed cleanup only restarts when required: %s',
        async (restartRequired) => {
            const cleanup = deferred<StorageCleanupResult>();
            mockTauriCommand('storage_cleanup_selected', () => cleanup.promise);
            const view = await openStorage();
            await openCleanup(view);
            await confirm();
            view.unmount();
            wrapper = undefined;
            cleanup.resolve(result({ restartRequired }));
            await flushPromises();
            expect(getTauriInvokeCalls('storage_scan')).toHaveLength(1);
            expect(getTauriInvokeCalls('plugin:process|restart')).toHaveLength(
                restartRequired ? 1 : 0
            );
            expect(document.querySelector('[data-sonner-toast]')).toBeNull();
        }
    );

    it('user reopens storage before an old scan finishes and only the new totals appear', async () => {
        const oldScan = deferred<StorageSummary>();
        mockTauriCommand('storage_scan', () => oldScan.promise);
        (await openStorage()).unmount();
        wrapper = undefined;
        mockTauriCommand('storage_scan', () => usage({ totalBytes: 50 * MIB }));
        const view = await openStorage();
        oldScan.resolve(usage({ totalBytes: 999 * MIB }));
        await flushPromises();
        expect(view.get('[data-testid=settings-storage-total]').text()).toContain('50 MiB');
        expect(view.text()).not.toContain('999 MiB');
    });
});
