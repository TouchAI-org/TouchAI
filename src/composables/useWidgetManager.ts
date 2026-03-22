// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolCall, AiToolCallDelta } from '@services/AiService/types';
import type { Ref } from 'vue';

import {
    buildShowWidgetDraftFromArgumentsBuffer,
    SHOW_WIDGET_TOOL_NAME,
    type ShowWidgetPayload,
} from '@/services/BuiltInToolService/tools/widgetTool';
import type { ConversationMessage, WidgetInfo } from '@/types/conversation';
import { normalizeString } from '@/utils/text';

interface UseWidgetManagerOptions {
    conversationHistory: Ref<ConversationMessage[]>;
    getAssistantMessageById: (messageId: string) => ConversationMessage | undefined;
}

/**
 * 管理 show_widget 工具在前端产出的 widget 运行时状态。
 *
 * 它只负责 widget 草稿、部件迁移与会话内 artifact 生命周期，
 * 不直接参与请求编排或工具审批状态机。
 */
export function useWidgetManager(options: UseWidgetManagerOptions) {
    const { conversationHistory, getAssistantMessageById } = options;
    const showWidgetCallIds = new Set<string>();

    const ensureAssistantWidgets = (message: ConversationMessage): WidgetInfo[] => {
        if (!message.widgets) {
            message.widgets = [];
        }

        return message.widgets;
    };

    const ensureWidgetPart = (message: ConversationMessage, widgetId: string): void => {
        const hasPart = message.parts.some(
            (part) => part.type === 'widget' && part.widgetId === widgetId
        );

        if (!hasPart) {
            message.parts.push({
                id: crypto.randomUUID(),
                type: 'widget',
                widgetId,
            });
        }
    };

    const retargetWidgetPart = (
        message: ConversationMessage,
        previousWidgetId: string,
        nextWidgetId: string
    ): void => {
        if (previousWidgetId === nextWidgetId) {
            return;
        }

        for (const part of message.parts) {
            if (part.type === 'widget' && part.widgetId === previousWidgetId) {
                part.widgetId = nextWidgetId;
            }
        }
    };

    const findWidgetTargetByCallId = (
        callId: string,
        preferredMessageId?: string
    ): { message: ConversationMessage; widget: WidgetInfo } | null => {
        if (preferredMessageId) {
            const preferredMessage = getAssistantMessageById(preferredMessageId);
            const preferredWidget = preferredMessage?.widgets?.find(
                (item) => item.callId === callId
            );
            if (preferredMessage && preferredWidget) {
                return { message: preferredMessage, widget: preferredWidget };
            }
        }

        for (let index = conversationHistory.value.length - 1; index >= 0; index -= 1) {
            const message = conversationHistory.value[index];
            if (!message || message.role !== 'assistant' || message.id === preferredMessageId) {
                continue;
            }

            const widget = message.widgets?.find((item) => item.callId === callId);
            if (widget) {
                return { message, widget };
            }
        }

        return null;
    };

    const findWidgetTarget = (
        widgetId: string,
        preferredMessageId?: string
    ): { message: ConversationMessage; widget: WidgetInfo } | null => {
        if (preferredMessageId) {
            const preferredMessage = getAssistantMessageById(preferredMessageId);
            const preferredWidget = preferredMessage?.widgets?.find(
                (item) => item.widgetId === widgetId
            );
            if (preferredMessage && preferredWidget) {
                return { message: preferredMessage, widget: preferredWidget };
            }
        }

        for (let index = conversationHistory.value.length - 1; index >= 0; index -= 1) {
            const message = conversationHistory.value[index];
            if (!message || message.role !== 'assistant' || message.id === preferredMessageId) {
                continue;
            }

            const widget = message.widgets?.find((item) => item.widgetId === widgetId);
            if (widget) {
                return { message, widget };
            }
        }

        return null;
    };

    const upsertWidget = (messageId: string, payload: ShowWidgetPayload): WidgetInfo | null => {
        const targetMessage =
            findWidgetTarget(payload.widgetId, messageId)?.message ??
            findWidgetTargetByCallId(payload.callId, messageId)?.message ??
            getAssistantMessageById(messageId);
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
    };

    /**
     * 先挂一个空的 draft widget，让内联 renderer 尽早进入就绪状态。
     *
     * 否则如果等到第一段 widget_code 才创建组件，运行时初始化还没完成时，
     * 多个 tool delta 会直接堆成“第一帧整块出现”的体感。
     */
    const ensureShowWidgetDraftShell = (messageId: string, callId: string): void => {
        upsertWidget(messageId, {
            callId,
            widgetId: callId,
            title: 'ShowWidget',
            description: '',
            html: '',
            mode: 'render',
            phase: 'draft',
        });
    };

    // 这组正则位于流式热路径里，预编译后可避免每个 delta 重建对象。
    const WIDGET_CODE_REGEX = /”widget_code”\s*:/;
    const I_HAVE_SEEN_README_REGEX = /”i_have_seen_read_me”\s*:\s*true/;
    const HTML_FIELD_REGEX = /”html”\s*:/;

    /**
     * 某些 OpenAI-compatible 网关会先吐 arguments，再很晚才补全 tool name。
     *
     * 这里用一个足够保守的启发式提前识别 show_widget，避免明明已经有
     * `widget_code` 片段了，却因为名字还没补齐而错过前几帧草稿。
     */
    const looksLikeShowWidgetArgumentsBuffer = (argumentsBuffer: string): boolean => {
        if (!argumentsBuffer.trim()) {
            return false;
        }

        if (WIDGET_CODE_REGEX.test(argumentsBuffer)) {
            return true;
        }

        return (
            I_HAVE_SEEN_README_REGEX.test(argumentsBuffer) && HTML_FIELD_REGEX.test(argumentsBuffer)
        );
    };

    /**
     * 某些 provider 不会稳定吐出 tool argument delta。
     *
     * 这里在 provider 已经给出完整 toolCalls、但工具尚未真正执行前，
     * 再补一次 ShowWidget draft，避免整个可视化退化成“执行完成后一次性出现”。
     */
    const upsertShowWidgetDraftFromFinalToolCall = (
        messageId: string,
        toolCall: AiToolCall
    ): void => {
        if (toolCall.name !== SHOW_WIDGET_TOOL_NAME) {
            return;
        }

        ensureShowWidgetDraftShell(messageId, toolCall.id);

        let argumentsObject: Record<string, unknown> = {};
        try {
            argumentsObject = JSON.parse(toolCall.arguments);
        } catch {
            return;
        }

        const mode = normalizeString(argumentsObject.mode);
        if (mode && mode !== 'render') {
            return;
        }

        const widgetId = normalizeString(argumentsObject.widgetId) || toolCall.id;
        const title = normalizeString(argumentsObject.title) || widgetId || '生成中的可视化';
        const description = normalizeString(argumentsObject.description);
        const html =
            normalizeString(argumentsObject.widget_code) || normalizeString(argumentsObject.html);

        upsertWidget(messageId, {
            callId: toolCall.id,
            widgetId,
            title,
            description,
            html,
            mode: 'render',
            phase: 'draft',
        });
    };

    const removeWidgetByWidgetId = (widgetId: string, preferredMessageId?: string): void => {
        const target = findWidgetTarget(widgetId, preferredMessageId);
        if (!target) {
            return;
        }

        target.message.widgets = target.message.widgets?.filter(
            (widget) => widget.widgetId !== widgetId
        );
        target.message.parts = target.message.parts.filter(
            (part) => !(part.type === 'widget' && part.widgetId === widgetId)
        );
    };

    const removeWidgetByCallId = (callId: string, options: { draftOnly?: boolean } = {}): void => {
        for (const message of conversationHistory.value) {
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
    };

    const isHiddenBuiltinToolCall = (namespacedName?: string): boolean => {
        return namespacedName === SHOW_WIDGET_TOOL_NAME;
    };

    /**
     * ShowWidget 需要在 tool call 真正执行前就开始显示生成中的 inline visual。
     *
     * provider 侧吐出的 partial JSON 会先走这里，尽量把 html/title/widgetId 提前解析成草稿。
     */
    const handleToolCallDelta = (messageId: string, toolCallDelta: AiToolCallDelta): void => {
        if (!toolCallDelta.callId) {
            return;
        }

        const streamedName = toolCallDelta.name;
        const matchesShowWidgetName =
            streamedName === SHOW_WIDGET_TOOL_NAME ||
            (typeof streamedName === 'string' &&
                (SHOW_WIDGET_TOOL_NAME.startsWith(streamedName) ||
                    streamedName.startsWith(SHOW_WIDGET_TOOL_NAME)));
        const matchesShowWidgetArguments = looksLikeShowWidgetArgumentsBuffer(
            toolCallDelta.argumentsBuffer
        );

        if (matchesShowWidgetName || matchesShowWidgetArguments) {
            showWidgetCallIds.add(toolCallDelta.callId);
            ensureShowWidgetDraftShell(messageId, toolCallDelta.callId);
        }

        if (!showWidgetCallIds.has(toolCallDelta.callId)) {
            return;
        }

        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            toolCallDelta.callId,
            toolCallDelta.argumentsBuffer
        );
        if (!draft || draft.mode !== 'render') {
            return;
        }

        upsertWidget(messageId, draft);
    };

    /**
     * 某次工具执行结束后，需要同步清理与该调用绑定的 showWidget 瞬时状态。
     */
    const finalizeToolCall = (callId: string, options: { removeDraft?: boolean } = {}): void => {
        showWidgetCallIds.delete(callId);

        if (options.removeDraft) {
            removeWidgetByCallId(callId, { draftOnly: true });
        }
    };

    const resetWidgetRuntime = (): void => {
        showWidgetCallIds.clear();
    };

    return {
        isHiddenBuiltinToolCall,
        upsertWidget,
        removeWidgetByWidgetId,
        handleToolCallDelta,
        upsertShowWidgetDraftFromFinalToolCall,
        finalizeToolCall,
        resetWidgetRuntime,
    };
}
