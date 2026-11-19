import { emit } from '@tauri-apps/api/event';
import { mockWindows } from '@tauri-apps/api/mocks';
import { describe, expect, it } from 'vitest';

import { initializeWindowPresentation } from '@/app/bootstrap/windowPresentation';

import { getTauriInvokeCalls, mockTauriCommand } from '../../utils/tauri';

describe('given each production window has its own presentation capability', () => {
    it('user can control search geometry only in main and cannot obtain an arbitrary native invoker', async () => {
        mockWindows('main');
        const main = initializeWindowPresentation();
        await main.search!.hideSearchWindow();
        expect(getTauriInvokeCalls('hide_search_window')).toEqual([
            { cmd: 'hide_search_window', payload: undefined },
        ]);
        expect(main.settings).toBeUndefined();
        expect(main.tray).toBeUndefined();
        expect(main.glow).toBeUndefined();
        expect(main.search).not.toHaveProperty('invoke');
        expect(main.search).not.toHaveProperty('getCurrentWindow');
        main.dispose();
        await expect(main.search!.hideSearchWindow()).rejects.toThrow('WINDOW_CLOSED');
        expect(getTauriInvokeCalls('hide_search_window')).toHaveLength(1);
    });

    it.each(['settings', 'tray-menu', 'computer-use-glow', 'unrecognized'])(
        'user in %s receives only its declared capability',
        async (label) => {
            mockWindows(label);
            const window = initializeWindowPresentation();
            expect(window.search).toBeUndefined();
            expect(Boolean(window.settings)).toBe(label === 'settings');
            expect(Boolean(window.tray)).toBe(label === 'tray-menu');
            expect(Boolean(window.glow)).toBe(label === 'computer-use-glow');
            expect(Boolean(window.diagnostics)).toBe(label === 'settings');
            window.dispose();
        }
    );

    it('user sees native feedback once and receives no update after the Glow client is closed', async () => {
        mockWindows('computer-use-glow');
        const feedback = { generation: 1, activities: [], banner: null, locale: 'en-US' };
        mockTauriCommand('computer_use_glow_snapshot', feedback);
        const window = initializeWindowPresentation();
        const observations: unknown[] = [];
        const stop = await window.glow!.onFeedback((value) => observations.push(value));
        expect(await window.glow!.readFeedback()).toEqual(feedback);
        await emit('computer-use-glow-pulse', feedback);
        expect(observations).toEqual([feedback]);
        window.dispose();
        await emit('computer-use-glow-pulse', { ...feedback, generation: 2 });
        expect(observations).toEqual([feedback]);
        stop();
    });
});
