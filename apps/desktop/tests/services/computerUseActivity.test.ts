import { emit } from '@tauri-apps/api/event';
import { installTauriMocks, mockTauriCommand, resetTauriMocks } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computerUseService } from '@/services/ComputerUseService';

const activeTasks = new Set<string>();
const pointers: unknown[] = [];

beforeEach(() => {
    installTauriMocks();
    activeTasks.clear();
    pointers.length = 0;
    mockTauriCommand('computer_use_glow_set_active', (payload: unknown) => {
        const { activityId, active } = payload as { activityId: string; active: boolean };
        if (active) activeTasks.add(activityId);
        else activeTasks.delete(activityId);
    });
    mockTauriCommand('computer_use_glow_pulse', (payload: unknown) => {
        pointers.push(payload);
    });
});

afterEach(() => {
    vi.useRealTimers();
    resetTauriMocks();
});

describe('computer use task activity', () => {
    it('user given concurrent computer tasks when pressing stop then cancels only the active computer tasks', async () => {
        const first = new AbortController();
        const second = new AbortController();
        const chat = new AbortController();
        computerUseService.bindTask(first.signal, () => first.abort());
        computerUseService.bindTask(second.signal, () => second.abort());
        computerUseService.bindTask(chat.signal, () => chat.abort());
        await computerUseService.startActivity(first.signal);
        await computerUseService.startActivity(second.signal);
        await emit('computer-use-stopped', [...activeTasks]);
        await vi.waitFor(() => expect(activeTasks.size).toBe(0));
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(true);
        expect(chat.signal.aborted).toBe(false);
        await computerUseService.pulseGlow({ x: 1, y: 2 }, first.signal);
        expect(pointers).toEqual([]);
    });

    it('user given a running desktop task when waiting between actions then keeps its cancellation identity until completion', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        await computerUseService.startActivity(controller.signal);
        await vi.advanceTimersByTimeAsync(60_000);
        await computerUseService.startActivity(controller.signal);
        expect(activeTasks.size).toBe(1);
        await computerUseService.endActivity(controller.signal);
        expect(activeTasks.size).toBe(0);
    });

    it('user given two active tasks when ending one then keeps the other task registered', async () => {
        const first = new AbortController();
        const second = new AbortController();
        await computerUseService.startActivity(first.signal);
        await computerUseService.startActivity(second.signal);
        await computerUseService.endActivity(first.signal);
        expect(activeTasks.size).toBe(1);
        await computerUseService.endActivity(second.signal);
        expect(activeTasks.size).toBe(0);
    });

    it('user given an active desktop task when cancelling then releases feedback without waiting for another model round', async () => {
        const controller = new AbortController();
        await computerUseService.startActivity(controller.signal);
        controller.abort();
        await Promise.resolve();
        await Promise.resolve();
        expect(activeTasks.size).toBe(0);
    });

    it('user given a cancelled task when a late action starts then does not reopen feedback', async () => {
        const controller = new AbortController();
        controller.abort();
        await computerUseService.startActivity(controller.signal);
        expect(activeTasks.size).toBe(0);
    });

    it('user given a completed task when its late pointer arrives then does not show it again', async () => {
        const controller = new AbortController();
        await computerUseService.startActivity(controller.signal);
        await computerUseService.endActivity(controller.signal);
        await computerUseService.pulseGlow({ x: 10, y: 20 }, controller.signal);
        expect(pointers).toEqual([]);
    });

    it('user given a completed task when a delayed action starts then does not reopen feedback', async () => {
        const controller = new AbortController();
        await computerUseService.endActivity(controller.signal);
        await computerUseService.startActivity(controller.signal);
        expect(activeTasks.size).toBe(0);
    });

    it('user given delayed feedback startup when cancelling then releases it after startup settles', async () => {
        let finishStart: (() => void) | undefined;
        mockTauriCommand('computer_use_glow_set_active', async (payload: unknown) => {
            const { activityId, active } = payload as { activityId: string; active: boolean };
            if (active) {
                await new Promise<void>((resolve) => {
                    finishStart = resolve;
                });
                activeTasks.add(activityId);
            } else activeTasks.delete(activityId);
        });
        const controller = new AbortController();
        const started = computerUseService.startActivity(controller.signal);
        await vi.waitFor(() => expect(finishStart).toBeDefined());
        const ended = computerUseService.endActivity(controller.signal);
        finishStart?.();
        await Promise.all([started, ended]);
        expect(activeTasks.size).toBe(0);
    });

    it('user given unavailable feedback when the next action retries then can recover without retaining a failed activity', async () => {
        mockTauriCommand('computer_use_glow_set_active', () => {
            throw new Error('Display unavailable');
        });
        const controller = new AbortController();
        await expect(computerUseService.startActivity(controller.signal)).rejects.toThrow(
            'Display unavailable'
        );
        expect(activeTasks.size).toBe(0);
        mockTauriCommand('computer_use_glow_set_active', (payload: unknown) => {
            const { activityId, active } = payload as { activityId: string; active: boolean };
            if (active) activeTasks.add(activityId);
            else activeTasks.delete(activityId);
        });
        await computerUseService.startActivity(controller.signal);
        expect(activeTasks.size).toBe(1);
        await computerUseService.endActivity(controller.signal);
        expect(activeTasks.size).toBe(0);
    });
});
