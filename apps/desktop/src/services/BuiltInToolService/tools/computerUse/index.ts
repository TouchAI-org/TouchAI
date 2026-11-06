// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { computerUseService, targetKey } from '@services/ComputerUseService';

import { tt } from '@/i18n';
import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';
import { truncateText } from '@/utils/text';

import type {
    BaseBuiltInToolExecutionContext,
    BuiltInToolExecutionResult,
    BuiltInToolGroup,
} from '../../types';
import { BuiltInTool } from '../../types';

type ComputerAction = 'observe' | 'click' | 'type' | 'key' | 'scroll' | 'launch';

interface ComputerUseConfig {
    allowForeground: boolean;
}

const MUTATING: ReadonlySet<ComputerAction> = new Set(['click', 'type', 'key', 'scroll']);

const DRIVER_TOOL: Record<ComputerAction, string> = {
    observe: 'get_window_state',
    click: 'click',
    type: 'type_text',
    key: 'press_key',
    scroll: 'scroll',
    launch: 'launch_app',
};

function normalizeAction(value: unknown): ComputerAction | null {
    return typeof value === 'string' && value in DRIVER_TOOL ? (value as ComputerAction) : null;
}

function pickArgs(action: ComputerAction, args: Record<string, unknown>): Record<string, unknown> {
    const target = {
        pid: args.pid,
        window_id: args.window_id,
    };
    const delivery = {
        delivery_mode: args.foreground === true ? 'foreground' : 'background',
    };
    switch (action) {
        case 'observe':
            return { ...target, include_screenshot: args.include_screenshot ?? false };
        case 'click':
            return { ...target, ...delivery, element_token: args.element_token };
        case 'type':
            return { ...target, ...delivery, element_token: args.element_token, text: args.text };
        case 'key':
            return {
                ...target,
                ...delivery,
                element_token: args.element_token,
                key: args.key,
                modifiers: args.modifiers,
            };
        case 'scroll':
            return {
                ...target,
                ...delivery,
                element_token: args.element_token,
                direction: args.direction,
                amount: args.amount,
            };
        case 'launch':
            return { name: args.app };
    }
}

class ComputerUseTool extends BuiltInTool<ComputerUseConfig> {
    readonly id = 'computer_use' as const;
    readonly displayName = tt('电脑操作');
    readonly description =
        'Observe and drive local desktop apps. Call action=observe first to get windows and element tokens, then click, type, or press keys by token. Actions run in the background unless foreground is explicitly allowed.';
    readonly defaultConfig: ComputerUseConfig = { allowForeground: false };
    readonly inputSchema: BuiltInTool['inputSchema'] = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['observe', 'click', 'type', 'key', 'scroll', 'launch'],
                description: 'Action to perform',
            },
            pid: { type: 'number', description: 'Target process id' },
            window_id: { type: 'number', description: 'Target window id' },
            element_token: {
                type: 'string',
                description: 'Element token returned by observe',
            },
            text: { type: 'string', description: 'Text to type' },
            key: {
                type: 'string',
                description: 'Key name, for example Enter, Tab, or s',
            },
            modifiers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Modifier keys held for the key press, for example ["Ctrl"]',
            },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            amount: { type: 'number', description: 'Scroll amount' },
            app: { type: 'string', description: 'Application name to launch' },
            foreground: {
                type: 'boolean',
                description:
                    'Set true only after a background attempt refuses and the user allows foreground delivery',
            },
        },
        required: ['action'],
    };

    override parseConfig(configJson: string | null): ComputerUseConfig {
        if (!configJson) return this.defaultConfig;
        try {
            const parsed = JSON.parse(configJson) as Partial<ComputerUseConfig>;
            return { allowForeground: parsed.allowForeground === true };
        } catch {
            return this.defaultConfig;
        }
    }

    override buildApprovalRequest(
        args: Record<string, unknown>,
        config: ComputerUseConfig
    ): Promise<ToolApprovalRequest | null> | null {
        void config;
        const action = normalizeAction(args.action);
        if (!action || !MUTATING.has(action)) return null;

        const key = targetKey(action, args.pid, args.window_id);
        const wantsForeground = args.foreground === true;

        return computerUseService.loadSettings().then((settings) => {
            if (
                !wantsForeground &&
                settings.approval === 'session-window' &&
                computerUseService.isAllowedForSession(key)
            ) {
                return null;
            }

            const target =
                typeof args.pid === 'number' ? `pid ${args.pid}` : String(args.app ?? 'desktop');
            const detail =
                action === 'type'
                    ? truncateText(String(args.text ?? ''), 80)
                    : action === 'key'
                      ? String(args.key ?? '')
                      : action === 'click'
                        ? String(args.element_token ?? '')
                        : `${String(args.direction ?? '')} ${String(args.amount ?? '')}`;

            return {
                title: tt('电脑操作确认'),
                description: tt('将对这个桌面目标执行一次操作'),
                command: truncateText(`${action} ${target} ${detail}`.trim(), 180),
                riskLabel: '',
                reason: wantsForeground
                    ? tt('前台升级会抢走焦点，需要单独确认')
                    : tt('桌面操作会真实影响你的应用'),
                commandLabel: '',
                approveLabel: tt('批准'),
                rejectLabel: tt('拒绝'),
                enterHint: 'Enter',
                escHint: 'Esc',
            } satisfies ToolApprovalRequest;
        });
    }

    async execute(
        args: Record<string, unknown>,
        _config: ComputerUseConfig,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        const action = normalizeAction(args.action);
        if (!action) {
            return {
                result: 'unsupported action',
                isError: true,
                status: 'error',
                errorMessage: 'unsupported action',
            };
        }

        const settings = await computerUseService.loadSettings();
        const key = targetKey(action, args.pid, args.window_id);

        const startedAt = Date.now();
        const invocation = computerUseService.execute(DRIVER_TOOL[action], pickArgs(action, args));

        let aborted = false;
        const onAbort = (): void => {
            aborted = true;
            void invocation.cancel();
        };
        context.signal?.addEventListener('abort', onAbort);

        try {
            const envelope = await invocation.result;
            const settled = {
                durationMs: Date.now() - startedAt,
                succeeded: envelope['isError'] !== true,
            };
            await computerUseService.recordAction(settled);

            const text = extractText(envelope);
            if (
                settled.succeeded &&
                MUTATING.has(action) &&
                settings.approval === 'session-window'
            ) {
                computerUseService.allowForSession(key);
            }
            return {
                result: text,
                isError: settled.succeeded ? false : true,
                status: settled.succeeded ? 'success' : 'error',
                structuredPayload: {
                    action,
                    effect: readStructuredField(envelope, 'effect'),
                    kind: 'computer_use',
                    pid: typeof args.pid === 'number' ? args.pid : undefined,
                    route: readStructuredField(envelope, 'route'),
                    windowId: typeof args.window_id === 'number' ? args.window_id : undefined,
                },
            };
        } catch (error) {
            await computerUseService.recordAction({
                denied: aborted,
                durationMs: Date.now() - startedAt,
                succeeded: false,
            });
            return {
                result: aborted ? tt('已取消') : String(error),
                isError: true,
                status: aborted ? 'timeout' : 'error',
                errorMessage: String(error),
            };
        } finally {
            context.signal?.removeEventListener('abort', onAbort);
        }
    }
}

function readStructuredField(envelope: Record<string, unknown>, field: string): string | undefined {
    const structured = envelope['structuredContent'];
    if (!structured || typeof structured !== 'object') return undefined;
    const value = (structured as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
}

function extractText(envelope: Record<string, unknown>): string {
    const content = envelope['content'];
    if (Array.isArray(content)) {
        const parts = content
            .map((item) =>
                item && typeof item === 'object' && 'text' in item
                    ? String((item as { text?: unknown }).text ?? '')
                    : ''
            )
            .filter(Boolean);
        if (parts.length > 0) return parts.join('\n');
    }
    const structured = envelope['structuredContent'];
    return structured ? JSON.stringify(structured) : '{}';
}

export const builtInTools: BuiltInToolGroup = [new ComputerUseTool()];
export { ComputerUseTool };
