// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Widget 生命周期投影。
 *
 * 持有 `show_widget` 流式草稿检测所需的内部状态，
 * 负责会话消息中 `WidgetInfo` 的创建、更新、匹配与删除。
 */

import {
    buildShowWidgetDraftFromArgumentsBuffer,
    SHOW_WIDGET_TOOL_NAME,
    type ShowWidgetPayload,
} from '@/services/BuiltInToolService/tools/widgetTool';
import type { SessionMessage, WidgetInfo } from '@/types/session';
import { normalizeString } from '@/utils/text';

import type { AiToolCall, AiToolCallDelta } from '../../contracts/tooling';
import {
    ensureAssistantWidgets,
    ensureWidgetPart,
    findWidgetTarget,
    findWidgetTargetByCallId,
    retargetWidgetPart,
} from '../../session/widgets';

// ────────────────────── ProjectionWidgets ──────────────────────

/**
 * Widget 投影状态管理器。
 *
 * 追踪正在流式构建中的 `show_widget` 调用，
 * 并提供 widget 的 upsert / 删除 / 草稿构建等操作。
 */
export class ProjectionWidgets {
    private readonly showWidgetCallIds = new Set<string>();
    private readonly widgetCodeRegex = /"widget_code"\s*:/;
    private readonly readmeRegex = /"i_have_seen_read_me"\s*:\s*true/;
    private readonly htmlRegex = /"html"\s*:/;

    resetTransientState(): void {
        this.showWidgetCallIds.clear();
    }

    isHiddenBuiltinToolCall(namespacedName?: string): boolean {
        return namespacedName === SHOW_WIDGET_TOOL_NAME;
    }

    upsertWidget(
        history: SessionMessage[],
        messageId: string,
        payload: ShowWidgetPayload
    ): WidgetInfo | null {
        const targetMessage =
            findWidgetTarget(history, payload.widgetId, messageId)?.message ??
            findWidgetTargetByCallId(history, payload.callId, messageId)?.message ??
            history.find((message) => message.id === messageId);
        if (!targetMessage) {
            return null;
        }

        const widgets = ensureAssistantWidgets(targetMessage);
        const existingWidget =
            widgets.find((widget) => widget.widgetId === payload.widgetId) ??
            widgets.find((widget) => widget.callId === payload.callId);

        if (existingWidget) {
            const previousWidgetId = existingWidget.widgetId;
            Object.assign(existingWidget, payload, {
                id: payload.widgetId,
                updatedAt: Date.now(),
            });
            retargetWidgetPart(targetMessage, previousWidgetId, payload.widgetId);
            ensureWidgetPart(targetMessage, payload.widgetId);
            return existingWidget;
        }

        const widget: WidgetInfo = {
            id: payload.widgetId,
            ...payload,
            updatedAt: Date.now(),
        };
        widgets.push(widget);
        ensureWidgetPart(targetMessage, payload.widgetId);
        return widget;
    }

    removeWidgetByWidgetId(
        history: SessionMessage[],
        widgetId: string,
        preferredMessageId?: string
    ): void {
        const target = findWidgetTarget(history, widgetId, preferredMessageId);
        if (!target) {
            return;
        }

        target.message.widgets = target.message.widgets?.filter(
            (widget) => widget.widgetId !== widgetId
        );
        target.message.parts = target.message.parts.filter(
            (part) => !(part.type === 'widget' && part.widgetId === widgetId)
        );
    }

    removeWidgetByCallId(
        history: SessionMessage[],
        callId: string,
        options: { draftOnly?: boolean } = {}
    ): void {
        for (const message of history) {
            if (message.role !== 'assistant' || !message.widgets?.length) {
                continue;
            }

            const removedWidgetIds = message.widgets
                .filter((widget) => {
                    if (widget.callId !== callId) {
                        return false;
                    }

                    if (!options.draftOnly) {
                        return true;
                    }

                    return widget.phase === 'draft';
                })
                .map((widget) => widget.widgetId);

            if (removedWidgetIds.length === 0) {
                continue;
            }

            message.widgets = message.widgets.filter(
                (widget) => !removedWidgetIds.includes(widget.widgetId)
            );
            message.parts = message.parts.filter(
                (part) => !(part.type === 'widget' && removedWidgetIds.includes(part.widgetId))
            );
        }
    }

    /**
     * 工具调用结束后清理流式草稿跟踪状态。
     */
    finalizeToolCall(
        history: SessionMessage[],
        callId: string,
        options: { removeDraft?: boolean } = {}
    ): void {
        this.showWidgetCallIds.delete(callId);

        if (options.removeDraft) {
            this.removeWidgetByCallId(history, callId, { draftOnly: true });
        }
    }

    /**
     * 处理流式 tool_call delta，检测并构建 `show_widget` 草稿。
     */
    handleToolCallDelta(
        history: SessionMessage[],
        messageId: string,
        toolCallDelta: AiToolCallDelta
    ): void {
        if (!toolCallDelta.callId) {
            return;
        }

        const streamedName = toolCallDelta.name;
        const matchesShowWidgetName =
            streamedName === SHOW_WIDGET_TOOL_NAME ||
            (typeof streamedName === 'string' &&
                (SHOW_WIDGET_TOOL_NAME.startsWith(streamedName) ||
                    streamedName.startsWith(SHOW_WIDGET_TOOL_NAME)));
        const matchesShowWidgetArguments = this.looksLikeShowWidgetArgumentsBuffer(
            toolCallDelta.argumentsBuffer
        );

        if (matchesShowWidgetName || matchesShowWidgetArguments) {
            this.showWidgetCallIds.add(toolCallDelta.callId);
            this.ensureShowWidgetDraftShell(history, messageId, toolCallDelta.callId);
        }

        if (!this.showWidgetCallIds.has(toolCallDelta.callId)) {
            return;
        }

        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            toolCallDelta.callId,
            toolCallDelta.argumentsBuffer
        );
        if (!draft || draft.mode !== 'render') {
            return;
        }

        this.upsertWidget(history, messageId, draft);
    }

    /**
     * 流式结束后的最终 tool_call 处理，确保 widget 草稿已创建。
     */
    processFinishedToolCall(
        history: SessionMessage[],
        messageId: string,
        toolCall: AiToolCall
    ): void {
        if (toolCall.name !== SHOW_WIDGET_TOOL_NAME) {
            return;
        }

        this.ensureShowWidgetDraftShell(history, messageId, toolCall.id);

        let argumentsObject: Record<string, unknown> = {};
        try {
            argumentsObject = JSON.parse(toolCall.arguments) as Record<string, unknown>;
        } catch {
            return;
        }

        const mode = normalizeString(String(argumentsObject.mode ?? ''));
        if (mode && mode !== 'render') {
            return;
        }

        const widgetId = normalizeString(String(argumentsObject.widgetId ?? '')) || toolCall.id;
        const title =
            normalizeString(String(argumentsObject.title ?? '')) || widgetId || '生成中的可视化';
        const description = normalizeString(String(argumentsObject.description ?? ''));
        const html =
            normalizeString(String(argumentsObject.widget_code ?? '')) ||
            normalizeString(String(argumentsObject.html ?? ''));

        this.upsertWidget(history, messageId, {
            callId: toolCall.id,
            widgetId,
            title,
            description,
            html,
            mode: 'render',
            phase: 'draft',
        });
    }

    private ensureShowWidgetDraftShell(
        history: SessionMessage[],
        messageId: string,
        callId: string
    ): void {
        this.upsertWidget(history, messageId, {
            callId,
            widgetId: callId,
            title: 'ShowWidget',
            description: '',
            html: '',
            mode: 'render',
            phase: 'draft',
        });
    }

    private looksLikeShowWidgetArgumentsBuffer(argumentsBuffer: string): boolean {
        if (!argumentsBuffer.trim()) {
            return false;
        }

        if (this.widgetCodeRegex.test(argumentsBuffer)) {
            return true;
        }

        return this.readmeRegex.test(argumentsBuffer) && this.htmlRegex.test(argumentsBuffer);
    }
}
