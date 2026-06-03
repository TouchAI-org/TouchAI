// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { tt } from '@/i18n';
import { createAttachment } from '@/services/AgentService/infrastructure/attachments';
import { buildDesktopContextToolPayload } from '@/services/DesktopContextService/toolPayload';
import type {
    BoundDesktopContext,
    DesktopContextCapsule,
    DesktopContextInclude,
    DesktopContextToolRequest,
} from '@/services/DesktopContextService/types';
import { native } from '@/services/NativeService';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    DESKTOP_CONTEXT_INCLUDE_VALUES,
    DESKTOP_CONTEXT_TOOL_DESCRIPTION,
    DESKTOP_CONTEXT_TOOL_INPUT_SCHEMA,
    DESKTOP_CONTEXT_TOOL_NAME,
} from './constants';

const includeValues = new Set<string>(DESKTOP_CONTEXT_INCLUDE_VALUES);
const sensitiveIncludeValues = new Set<DesktopContextInclude>([
    'selected_text.full_text',
    'clipboard.summary',
    'clipboard.full_text',
    'screenshot.metadata',
    'screenshot.image',
]);

function parseDesktopContextRequest(args: Record<string, unknown>): DesktopContextToolRequest {
    const include = Array.isArray(args.include)
        ? args.include.filter((item): item is DesktopContextInclude => {
              return typeof item === 'string' && includeValues.has(item);
          })
        : undefined;

    return {
        ...(include ? { include } : {}),
        ...(typeof args.scope === 'string'
            ? { scope: args.scope as DesktopContextToolRequest['scope'] }
            : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(typeof args.screenshotTarget === 'string'
            ? {
                  screenshotTarget:
                      args.screenshotTarget as DesktopContextToolRequest['screenshotTarget'],
              }
            : {}),
    };
}

function hasSensitiveInclude(request: DesktopContextToolRequest): boolean {
    return request.include?.some((item) => sensitiveIncludeValues.has(item)) ?? false;
}

function hasScreenshotInclude(request: DesktopContextToolRequest): boolean {
    return (
        request.include?.some(
            (item) => item === 'screenshot.metadata' || item === 'screenshot.image'
        ) ?? false
    );
}

function describeSensitiveIncludes(request: DesktopContextToolRequest): string {
    const labels = new Set<string>();
    for (const item of request.include ?? []) {
        if (item.startsWith('selected_text.')) {
            labels.add(tt('选中文本原文'));
        } else if (item.startsWith('clipboard.')) {
            labels.add(tt('剪贴板'));
        } else if (item.startsWith('screenshot.')) {
            labels.add(tt('屏幕截图'));
        }
    }

    return [...labels].join(', ') || tt('敏感桌面上下文');
}

function bindCapturedCapsule(
    capsule: DesktopContextCapsule,
    currentContext: BoundDesktopContext
): BoundDesktopContext {
    return {
        ...capsule,
        boundAt: currentContext.boundAt,
    };
}

async function captureSensitiveContext(
    request: DesktopContextToolRequest,
    context: BoundDesktopContext | null | undefined
): Promise<{
    context: BoundDesktopContext | null | undefined;
    captured: boolean;
}> {
    if (!context || !hasSensitiveInclude(request)) {
        return { context, captured: false };
    }

    const capsule = await native.desktopContext.captureSensitive(
        context.id,
        request.include ?? [],
        request.screenshotTarget
    );

    return capsule
        ? { context: bindCapturedCapsule(capsule, context), captured: true }
        : { context, captured: false };
}

async function buildScreenshotAttachments(
    request: DesktopContextToolRequest,
    context: BoundDesktopContext | null | undefined
): Promise<BuiltInToolExecutionResult['attachments']> {
    if (!request.include?.includes('screenshot.image')) {
        return undefined;
    }

    const screenshot = context?.screenshot;
    if (!screenshot?.available || !screenshot.path) {
        return undefined;
    }

    try {
        return [await createAttachment('image', screenshot.path)];
    } catch (error) {
        console.warn('[DesktopContextTool] Failed to attach desktop screenshot:', error);
        return undefined;
    }
}

class DesktopContextTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'get_desktop_context' as const;
    readonly displayName = DESKTOP_CONTEXT_TOOL_NAME;
    readonly description = DESKTOP_CONTEXT_TOOL_DESCRIPTION;
    readonly inputSchema = DESKTOP_CONTEXT_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildConversationSemantic(): BuiltInToolConversationSemantic {
        return {
            action: 'review',
            target: '桌面上下文',
        };
    }

    override buildApprovalRequest(
        args: Record<string, unknown>,
        _config: Record<string, never>,
        _namespacedName: string,
        context: BaseBuiltInToolExecutionContext
    ) {
        const request = parseDesktopContextRequest(args);
        if (!context.desktopContext || !hasSensitiveInclude(request)) {
            return null;
        }

        const sensitiveTargets = describeSensitiveIncludes(request);
        return {
            title: tt('桌面上下文读取确认'),
            description: sensitiveTargets,
            command: request.include?.join(', ') ?? '',
            riskLabel: '',
            reason: tt(
                '模型请求读取 {targets}。批准后，TouchAI 会读取或捕获这些桌面上下文，并将结果发送给模型。',
                { targets: sensitiveTargets }
            ),
            commandLabel: '',
            approveLabel: tt('批准'),
            rejectLabel: tt('拒绝'),
            enterHint: 'Enter',
            escHint: 'Esc',
            keyboardApproveDelayMs: 450,
        };
    }

    override async execute(
        args: Record<string, unknown>,
        _config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        const request = parseDesktopContextRequest(args);
        const { context: desktopContext, captured } = await captureSensitiveContext(
            request,
            context.desktopContext
        );
        const payload = buildDesktopContextToolPayload(desktopContext, request);
        const attachments = await buildScreenshotAttachments(request, desktopContext);
        const desktopContextArtifact =
            captured && hasScreenshotInclude(request) && desktopContext?.screenshot.available
                ? desktopContext
                : undefined;

        return {
            result: JSON.stringify(payload, null, 2),
            isError: !payload.available,
            status: payload.available ? 'success' : 'error',
            errorMessage: payload.available ? undefined : payload.reason,
            attachments,
            desktopContextArtifact,
        };
    }
}

export const desktopContextTool = new DesktopContextTool();
export const builtInTools: BuiltInToolGroup = [desktopContextTool];
