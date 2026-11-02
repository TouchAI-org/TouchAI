import type { BaseBuiltInToolExecutionContext } from '@services/BuiltInToolService/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = {
    allowForeground: false,
    allowedApps: [],
    approval: 'each' as 'each' | 'session-window',
    cursorVisible: true,
    enabled: true,
    maxImageDimension: 1568,
    recordingEnabled: false,
    telemetryEnabled: false,
};

const allowed = new Set<string>();
const execute = vi.fn();
const cancel = vi.fn();
const recordAction = vi.fn();

vi.mock('@services/ComputerUseService', () => ({
    computerUseService: {
        allowForSession: (key: string) => allowed.add(key),
        execute: (...args: unknown[]) => execute(...args),
        isAllowedForSession: (key: string) => allowed.has(key),
        loadSettings: async () => settings,
        recordAction: (...args: unknown[]) => recordAction(...args),
    },
    targetKey: (action: string, pid?: unknown, windowId?: unknown) =>
        `${action}:${String(pid ?? '-')}:${String(windowId ?? '-')}`,
}));

const { ComputerUseTool } = await import('@services/BuiltInToolService/tools/computerUse/index');

const tool = new ComputerUseTool();

function context(signal?: AbortSignal): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-1',
        hasExecutedBuiltInTool: () => false,
        iteration: 1,
        signal,
    } as BaseBuiltInToolExecutionContext;
}

function driverResult(structured: Record<string, unknown> = {}) {
    return {
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        structuredContent: structured,
    };
}

beforeEach(() => {
    allowed.clear();
    execute.mockReset();
    cancel.mockReset();
    recordAction.mockReset();
    settings.approval = 'each';
    settings.allowForeground = false;
    execute.mockReturnValue({
        cancel,
        executionId: 'exec-1',
        result: Promise.resolve(driverResult({ effect: 'confirmed', route: 'accessibility' })),
    });
});

describe('computer use tool', () => {
    it('user observes a window without being asked to approve', async () => {
        const request = await Promise.resolve(
            tool.buildApprovalRequest({ action: 'observe', pid: 1 }, tool.defaultConfig)
        );

        expect(request).toBeNull();
    });

    it('user sees the target window in the approval for a click', async () => {
        const request = await tool.buildApprovalRequest(
            { action: 'click', element_token: 's1:2', pid: 12, window_id: 34 },
            tool.defaultConfig
        );

        expect(request?.command).toContain('pid 12');
        expect(request?.command).toContain('s1:2');
        expect(request?.approveLabel).toBe('批准');
    });

    it('user is not asked again for the same action on an allowed window', async () => {
        settings.approval = 'session-window';
        allowed.add('click:12:34');

        await expect(
            tool.buildApprovalRequest(
                { action: 'click', pid: 12, window_id: 34 },
                tool.defaultConfig
            )
        ).resolves.toBeNull();
    });

    it('user still confirms a foreground escalation on an allowed window', async () => {
        settings.approval = 'session-window';
        allowed.add('click:12:34');

        const request = await tool.buildApprovalRequest(
            { action: 'click', foreground: true, pid: 12, window_id: 34 },
            tool.defaultConfig
        );

        expect(request).not.toBeNull();
        expect(request?.reason).toContain('前台升级');
    });

    it('user sees the click routed in the background with its verdict', async () => {
        const result = await tool.execute(
            { action: 'click', element_token: 's1:2', pid: 12, window_id: 34 },
            tool.defaultConfig,
            context()
        );

        expect(execute).toHaveBeenCalledWith('click', {
            delivery_mode: 'background',
            element_token: 's1:2',
            pid: 12,
            window_id: 34,
        });
        expect(result.isError).toBe(false);
        expect(result.structuredPayload).toMatchObject({
            action: 'click',
            effect: 'confirmed',
            kind: 'computer_use',
            route: 'accessibility',
        });
        expect(recordAction).toHaveBeenCalledWith(expect.objectContaining({ succeeded: true }));
    });

    it('user sees a foreground request escalated explicitly', async () => {
        settings.allowForeground = true;

        await tool.execute(
            { action: 'click', element_token: 's1:2', foreground: true, pid: 12, window_id: 34 },
            { allowForeground: true },
            context()
        );

        expect(execute).toHaveBeenCalledWith(
            'click',
            expect.objectContaining({ delivery_mode: 'foreground' })
        );
    });

    it('user sees typing, keys, scrolling and launching reach the driver', async () => {
        await tool.execute(
            { action: 'type', pid: 1, text: 'hello', window_id: 2 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith(
            'type_text',
            expect.objectContaining({
                text: 'hello',
            })
        );

        await tool.execute(
            { action: 'key', key: 's', modifiers: ['Ctrl'], pid: 1, window_id: 2 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith(
            'press_key',
            expect.objectContaining({
                key: 's',
                modifiers: ['Ctrl'],
            })
        );

        await tool.execute(
            { action: 'scroll', amount: 3, direction: 'down', pid: 1, window_id: 2 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith(
            'scroll',
            expect.objectContaining({
                amount: 3,
                direction: 'down',
            })
        );

        await tool.execute({ action: 'launch', app: 'notepad.exe' }, tool.defaultConfig, context());
        expect(execute).toHaveBeenLastCalledWith('launch_app', { name: 'notepad.exe' });
    });

    it('user sees a driver error reported as a failed action', async () => {
        execute.mockReturnValue({
            cancel,
            executionId: 'exec-1',
            result: Promise.resolve({
                content: [{ type: 'text', text: 'window_target_not_found' }],
                isError: true,
            }),
        });

        const result = await tool.execute(
            { action: 'click', element_token: 's1:2', pid: 1, window_id: 2 },
            tool.defaultConfig,
            context()
        );

        expect(result.isError).toBe(true);
        expect(result.status).toBe('error');
        expect(result.result).toBe('window_target_not_found');
        expect(recordAction).toHaveBeenCalledWith(expect.objectContaining({ succeeded: false }));
    });

    it('user cancelling the action stops the driver call', async () => {
        const controller = new AbortController();
        execute.mockReturnValue({
            cancel,
            executionId: 'exec-1',
            result: new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error('cancelled')), 0);
            }),
        });

        const pending = tool.execute(
            { action: 'click', element_token: 's1:2', pid: 1, window_id: 2 },
            tool.defaultConfig,
            context(controller.signal)
        );
        await Promise.resolve();
        controller.abort();

        const result = await pending;
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(result.isError).toBe(true);
        expect(result.status).toBe('timeout');
    });

    it('user sees an unknown action rejected without touching the driver', async () => {
        const result = await tool.execute({ action: 'explode' }, tool.defaultConfig, context());

        expect(execute).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe('unsupported action');
    });
});
