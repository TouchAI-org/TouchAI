import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import DataLocationRow from '@/views/SettingsView/components/DataManagement/components/DataLocationRow.vue';

import { getTauriInvokeCalls, mockTauriCommand } from '../utils/tauri';

let wrapper: VueWrapper | undefined;
const current = { currentPath: 'C:/fixture', pendingPath: null, notice: null, previousPath: null };

async function openLocation() {
    wrapper = mount(DataLocationRow, { props: { disabled: false }, attachTo: document.body });
    await flushPromises();
    return wrapper;
}

async function confirmMove(label: string) {
    const button = [
        ...document.querySelectorAll<HTMLButtonElement>('[role=alertdialog] button'),
    ].find((button) => button.textContent?.trim() === label);
    expect(button).toBeDefined();
    button!.click();
    await flushPromises();
}

beforeEach(() => {
    setLocale('en-US');
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    mockTauriCommand('storage_get_location', () => current);
    mockTauriCommand('plugin:dialog|open', 'D:/TouchAI');
    mockTauriCommand('storage_schedule_move', () => ({ ...current, pendingPath: 'D:/TouchAI' }));
    mockTauriCommand('storage_cancel_move', () => current);
    mockTauriCommand('plugin:process|restart', undefined);
});
afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    await flushPromises();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    setLocale('zh-CN');
});

describe('given the user can choose where local data lives', () => {
    it('user opens a canonical Windows location then sees a familiar folder path', async () => {
        mockTauriCommand('storage_get_location', () => ({
            ...current,
            currentPath: '\\\\?\\C:\\TouchAI',
        }));
        const view = await openLocation();
        expect(view.text()).toContain('C:\\TouchAI');
        expect(view.text()).not.toContain('\\\\?\\');
    });

    it('user chooses a folder and confirms then schedules the move and restarts', async () => {
        const view = await openLocation();
        expect(view.text()).toContain('C:/fixture');
        await view.get('[data-testid=settings-data-move]').trigger('click');
        await flushPromises();
        expect(document.querySelector('[role=alertdialog]')?.textContent).toContain('D:/TouchAI');
        expect(getTauriInvokeCalls('storage_schedule_move')).toEqual([]);
        await confirmMove('Confirm');
        expect(getTauriInvokeCalls('storage_schedule_move').map((call) => call.payload)).toEqual([
            { destination: 'D:/TouchAI' },
        ]);
        expect(getTauriInvokeCalls('plugin:process|restart')).toHaveLength(1);
    });

    it('user cancels confirmation then no data move or restart begins', async () => {
        const view = await openLocation();
        await view.get('[data-testid=settings-data-move]').trigger('click');
        await flushPromises();
        await confirmMove('Cancel');
        expect(getTauriInvokeCalls('storage_schedule_move')).toEqual([]);
        expect(getTauriInvokeCalls('plugin:process|restart')).toEqual([]);
    });

    it('user chooses an occupied destination then sees a useful refusal and keeps the current path', async () => {
        mockTauriCommand('storage_schedule_move', () => {
            throw 'storage_move_not_empty';
        });
        const view = await openLocation();
        await view.get('[data-testid=settings-data-move]').trigger('click');
        await flushPromises();
        await confirmMove('Confirm');
        expect(view.get('[role=alert]').text()).toContain('Choose an empty folder');
        expect(view.text()).toContain('C:/fixture');
        expect(getTauriInvokeCalls('plugin:process|restart')).toEqual([]);
    });

    it('user cannot restart automatically then can cancel the pending move', async () => {
        mockTauriCommand('plugin:process|restart', () => {
            throw 'unavailable';
        });
        const view = await openLocation();
        await view.get('[data-testid=settings-data-move]').trigger('click');
        await flushPromises();
        await confirmMove('Confirm');
        expect(view.text()).toContain('Move after restarting: D:/TouchAI');
        const cancel = view.findAll('button').find((button) => button.text() === 'Cancel')!;
        await cancel.trigger('click');
        await flushPromises();
        expect(getTauriInvokeCalls('storage_cancel_move')).toHaveLength(1);
        expect(view.text()).not.toContain('Move after restarting:');
    });

    it('user leaves before confirming then a detached confirmation cannot schedule a move', async () => {
        const view = await openLocation();
        await view.get('[data-testid=settings-data-move]').trigger('click');
        await flushPromises();
        const button = [
            ...document.querySelectorAll<HTMLButtonElement>('[role=alertdialog] button'),
        ].find((button) => button.textContent?.trim() === 'Confirm')!;
        view.unmount();
        wrapper = undefined;
        button.click();
        await flushPromises();
        expect(getTauriInvokeCalls('storage_schedule_move')).toEqual([]);
    });
});
