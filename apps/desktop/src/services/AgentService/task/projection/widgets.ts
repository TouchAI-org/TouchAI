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

interface WidgetDraftBuildState {
    applied: string;
    pending: string | null;
    lastBuildAt: number | null;
    timer: ReturnType<typeof setTimeout> | null;
    history: SessionMessage[];
    messageId: string;
}

// 流式参数 buffer 的草稿重建间隔；窗口内的 delta 只记录最新 buffer。
const WIDGET_DRAFT_REBUILD_INTERVAL_MS = 80;

/**
 * 只有累计参数超过该长度才启用节流。
 *
 * 小体量草稿（刚开始的几十个字符）重建很便宜，保持与每个 delta 同步，
 * 以免草稿展示滞后；真正贵的是大段生成中的 HTML。
 */
const WIDGET_DRAFT_THROTTLE_MIN_CHARS = 2000;

/**
 * Widget 投影状态管理器。
 *
 * 追踪正在流式构建中的 `show_widget` 调用，
 * 并提供 widget 的 upsert / 删除 / 草稿构建等操作。
 */
export class ProjectionWidgets {
    private readonly showWidgetCallIds = new Set<string>();
    private readonly draftBuildStates = new Map<string, WidgetDraftBuildState>();
    private readonly widgetCodeRegex = /"widget_code"\s*:/;
    private readonly readmeRegex = /"i_have_seen_read_me"\s*:\s*true/;
    private readonly htmlRegex = /"html"\s*:/;

    resetTransientState(): void {
        this.showWidgetCallIds.clear();
        for (const state of this.draftBuildStates.values()) {
            if (state.timer) {
                clearTimeout(state.timer);
            }
        }
        this.draftBuildStates.clear();
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
        this.clearDraftBuildState(callId);

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

        this.requestDraftRebuild(
            history,
            messageId,
            toolCallDelta.callId,
            toolCallDelta.argumentsBuffer
        );
    }

    /**
     * 去重 + 节流重建 widget 草稿。
     *
     * 相同的累计参数 buffer 不重复解析整段 JSON；
     * 窗口内的增量 delta 只记住最新 buffer，到窗口尾部重建一次。
     */
    private requestDraftRebuild(
        history: SessionMessage[],
        messageId: string,
        callId: string,
        buffer: string
    ): void {
        const existing = this.draftBuildStates.get(callId);
        const state: WidgetDraftBuildState = existing ?? {
            applied: '',
            pending: null,
            lastBuildAt: null,
            timer: null,
            history,
            messageId,
        };
        state.history = history;
        state.messageId = messageId;

        if (state.applied === buffer && state.pending === null) {
            return;
        }

        const now = Date.now();
        if (
            buffer.length >= WIDGET_DRAFT_THROTTLE_MIN_CHARS &&
            state.lastBuildAt !== null &&
            now - state.lastBuildAt < WIDGET_DRAFT_REBUILD_INTERVAL_MS
        ) {
            state.pending = buffer;
            this.draftBuildStates.set(callId, state);
            if (!state.timer) {
                state.timer = setTimeout(
                    () => {
                        state.timer = null;
                        const next = state.pending;
                        state.pending = null;
                        if (next === null || next === state.applied) {
                            return;
                        }
                        this.applyDraftBuild(state.history, state.messageId, callId, next);
                    },
                    Math.max(0, WIDGET_DRAFT_REBUILD_INTERVAL_MS - (now - state.lastBuildAt))
                );
            }
            return;
        }

        this.draftBuildStates.set(callId, state);
        this.applyDraftBuild(history, messageId, callId, buffer);
    }

    private applyDraftBuild(
        history: SessionMessage[],
        messageId: string,
        callId: string,
        buffer: string
    ): void {
        const state = this.draftBuildStates.get(callId);
        if (state) {
            state.applied = buffer;
            state.lastBuildAt = Date.now();
        }

        const draft = buildShowWidgetDraftFromArgumentsBuffer(callId, buffer);
        if (!draft || draft.mode !== 'render') {
            return;
        }

        this.upsertWidget(history, messageId, draft);
    }

    private clearDraftBuildState(callId: string): void {
        const state = this.draftBuildStates.get(callId);
        if (state?.timer) {
            clearTimeout(state.timer);
        }
        this.draftBuildStates.delete(callId);
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

        // 最终态优先：取消可能存在的 trailing 草稿重建，避免用草稿覆盖最终 widget。
        this.clearDraftBuildState(toolCall.id);
        this.ensureShowWidgetDraftShell(history, messageId, toolCall.id);

        let argumentsObject: Record<string, unknown>;
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
