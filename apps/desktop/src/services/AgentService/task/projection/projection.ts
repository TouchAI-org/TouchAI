// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 任务投影器（协调层）。
 *
 * 负责把底层运行事件整理成 UI 可直接消费的任务快照。
 * Widget、审批、工具调用三个子关注点分别由同目录下的对应模块承载，
 * 本文件只保留核心生命周期、消息管理和跨子关注点的编排逻辑。
 */

import { tt } from '@/i18n';
import {
    cloneInputHistorySnapshot,
    createInputHistorySnapshot,
    type PendingToolApproval,
    type SessionMessage,
    type ToolApprovalInfo,
} from '@/types/session';
import { createReasoningPart, createTextPart, selectToolCalls } from '@/utils/session';

import { AiError } from '../../contracts/errors';
import type { AiStreamChunk, ContextCompactionEvent } from '../../contracts/protocol';
import type {
    AskUserAnswer,
    ToolApprovalDecisionRequest,
    ToolEvent,
} from '../../contracts/tooling';
import { getRetryStatusMessage } from '../../execution/retry';
import type { RuntimeTurnEvent } from '../../execution/runtime';
import {
    type InteractionRelease,
    type PendingUserQuestion,
    TaskInteractions,
} from '../interactions';
import type {
    DeliveredPendingUserMessage,
    StartSessionTaskOptions,
    TaskViewSnapshot,
} from '../types';
import {
    attachStatusText,
    cloneValue,
    createDerivedStatusMessage,
    createTaskModelFromToolEvent,
    isCancellationStatusText,
    isTerminalStatus,
} from './helpers';
import { syncBuiltInToolCallPresentation, updateToolCallStatus, upsertToolCall } from './toolCalls';
import {
    type ApprovalSettlementResult,
    ProjectionUserPrompts,
    removeToolApproval,
    resolveApprovalResolutionText,
    updateToolApproval,
} from './userPrompts';
import { ProjectionWidgets } from './widgets';

interface CheckpointPresentation {
    sessionHistory: SessionMessage[];
    activeAssistantMessageId: string | null;
    response: string;
    reasoning: string;
}

/**
 * 任务投影器。
 *
 * 仍放在 `task` 层内部，而不是单独暴露给页面层，
 * 因为这些状态归并规则本质上属于"任务真相源如何对外呈现"的内部实现。
 */
export class SessionTaskProjection {
    private response = '';
    private reasoning = '';
    private activeAssistantMessageId: string | null = null;
    private lastCheckpointPresentation: CheckpointPresentation | null = null;

    private readonly widgets = new ProjectionWidgets(() => {
        this.touch();
        this.publish();
    });
    private readonly userPrompts = new ProjectionUserPrompts();

    constructor(
        private readonly snapshot: TaskViewSnapshot,
        private readonly publish: () => void,
        private readonly interactions: TaskInteractions = new TaskInteractions()
    ) {}

    // ────────────────────── 公共 API ──────────────────────

    bootstrap(
        history: SessionMessage[],
        prompt: string,
        attachments: StartSessionTaskOptions['attachments'],
        inputSnapshot?: StartSessionTaskOptions['inputSnapshot'],
        userMessageId?: string
    ): void {
        this.snapshot.sessionHistory = cloneValue(history);
        const snapshotAttachments = inputSnapshot?.attachments ?? attachments ?? [];
        const userInputSnapshot = createInputHistorySnapshot({
            text: prompt,
            attachments: snapshotAttachments,
            skills: inputSnapshot?.skills ?? [],
            editorDoc: inputSnapshot?.editorDoc,
            excludeFromHistory: inputSnapshot?.excludeFromHistory,
        });
        this.snapshot.sessionHistory.push({
            id: userMessageId ?? crypto.randomUUID(),
            role: 'user',
            content: prompt,
            attachments: snapshotAttachments.length ? cloneValue(snapshotAttachments) : undefined,
            inputSnapshot: cloneInputHistorySnapshot(userInputSnapshot) ?? undefined,
            parts: [],
            timestamp: Date.now(),
        });

        this.createStreamingAssistantMessage();
        this.snapshot.status = 'running';
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    getActiveAssistantMessageId(): string | null {
        return this.activeAssistantMessageId;
    }

    getPendingToolApproval(): PendingToolApproval | null {
        return this.interactions.pendingApproval;
    }

    /**
     * 纯格式化：生成审批展示数据，不登记等待、不创建 Promise。
     */
    formatApproval(payload: ToolApprovalDecisionRequest): PendingToolApproval {
        return this.userPrompts.formatApproval(this.activeAssistantMessageId, payload);
    }

    /**
     * 把已经登记的审批渲染成卡片与工具调用状态，并对外发布。
     *
     * 等待权与 resolver 归 `TaskInteractions`；这里只做展示同步。
     */
    renderApproval(display: PendingToolApproval, payload: ToolApprovalDecisionRequest): void {
        const messageId = this.activeAssistantMessageId;
        this.userPrompts.renderApprovalCard(
            this.snapshot.sessionHistory,
            messageId,
            display,
            payload
        );
        if (messageId) {
            updateToolCallStatus(
                this.snapshot.sessionHistory,
                messageId,
                display.callId,
                (toolCall) => {
                    toolCall.status = 'awaiting_approval';
                }
            );
        }

        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    /** 把已经登记的提问渲染成工具调用等待状态，并对外发布。 */
    renderQuestion(record: PendingUserQuestion): void {
        const messageId = record.sourceMessageId || null;
        if (messageId) {
            updateToolCallStatus(
                this.snapshot.sessionHistory,
                messageId,
                record.callId,
                (toolCall) => {
                    toolCall.status = 'awaiting_approval';
                }
            );
        }

        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    getPendingUserQuestion(): PendingUserQuestion | null {
        return this.interactions.pendingQuestion;
    }

    /**
     * 结算审批并把结果落到卡片上。
     *
     * 决定必须携带当前 generation 的 `decisionId`；旧 token / 旧 generation 一律拒绝。
     */
    settleInteractionApproval(
        callId: string,
        approved: boolean,
        options: { decisionId?: string; resolutionText?: string } = {}
    ): boolean {
        const settlement = this.interactions.settleApproval(callId, approved, options.decisionId);
        if (!settlement) {
            return false;
        }

        this.applyApprovalSettlement(
            this.buildSettlementResult(settlement.display, approved, options.resolutionText)
        );
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
        return true;
    }

    settleInteractionQuestion(
        callId: string,
        answers: AskUserAnswer[] | null,
        decisionId?: string
    ): boolean {
        const settled = this.interactions.settleQuestion(callId, answers, decisionId);
        if (!settled) {
            return false;
        }
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
        return true;
    }

    clearPendingApprovals(reason = tt('请求已取消')): void {
        this.applyInteractionSettlements(this.interactions.cancelAll(), reason);
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    /** 把一次交互释放（重试/终态/取消）同步到审批卡片与快照。 */
    syncInteractionRelease(release: InteractionRelease, reason: string): void {
        if (release.approvals.length === 0 && release.questionCallIds.length === 0) {
            return;
        }

        this.applyInteractionSettlements(release, reason);
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    private applyInteractionSettlements(release: InteractionRelease, reason: string): void {
        const settledCallIds = new Set(release.approvals.map((item) => item.display.callId));
        for (const item of release.approvals) {
            this.applyApprovalSettlement(
                this.buildSettlementResult(item.display, item.approved, reason)
            );
        }
        for (const result of this.collectDisplayedApprovalSettlements(reason, settledCallIds)) {
            this.applyApprovalSettlement(result);
        }
    }

    private finishReasoningPart(message: SessionMessage): void {
        const part = message.parts[message.parts.length - 1];
        if (part?.type !== 'reasoning' || !part.isStreaming) return;
        part.isStreaming = false;
        if (part.startedAt !== undefined) {
            part.endedAt = Date.now();
        }
        // 无正文的 start/end 只用于实时占位，不留下空历史块。
        if (!part.content.trim()) message.parts.pop();
    }

    private clearPendingCompaction(message: SessionMessage): void {
        message.parts = message.parts.filter(
            (part) => part.type !== 'context_compaction' || part.state !== 'compacting'
        );
    }

    private handleCompaction(message: SessionMessage, event: ContextCompactionEvent): void {
        // Cached summaries can be replayed after a retry or view reattachment.
        for (const item of this.snapshot.sessionHistory) {
            const existing = item.parts.find(
                (part) => part.type === 'context_compaction' && part.id === event.id
            );
            if (existing?.type !== 'context_compaction') continue;
            if (event.state === 'failed')
                item.parts = item.parts.filter((part) => part !== existing);
            else existing.state = event.state;
            return;
        }
        if (event.state === 'failed') return;
        this.finishReasoningPart(message);
        message.parts.push({ id: event.id, type: 'context_compaction', state: event.state });
    }

    handleChunk(chunk: AiStreamChunk): void {
        const assistantMessage = this.getActiveAssistantMessage();
        if (!assistantMessage) {
            return;
        }

        if (chunk.contextCompaction) {
            this.handleCompaction(assistantMessage, chunk.contextCompaction);
            this.touch();
            this.publish();
            return;
        }

        if (chunk.toolEvent?.type === 'request_retry') {
            this.clearPendingCompaction(assistantMessage);
            this.finishReasoningPart(assistantMessage);
            this.handleRetryEvent(assistantMessage, chunk.toolEvent);
            return;
        }

        if (chunk.reasoningState === 'start') {
            this.finishReasoningPart(assistantMessage);
            assistantMessage.parts.push(createReasoningPart('', true));
        }

        if (chunk.reasoning) {
            this.reasoning += chunk.reasoning;
            assistantMessage.reasoning = this.reasoning;
            const lastPart = assistantMessage.parts[assistantMessage.parts.length - 1];
            if (lastPart?.type === 'reasoning' && lastPart.isStreaming) {
                lastPart.content += chunk.reasoning;
            } else {
                assistantMessage.parts.push(createReasoningPart(chunk.reasoning, true));
            }
        }

        if (
            chunk.reasoningState === 'end' ||
            chunk.content ||
            chunk.done ||
            chunk.toolCallDeltas?.length ||
            chunk.toolCalls?.length ||
            chunk.toolEvent
        ) {
            this.finishReasoningPart(assistantMessage);
        }

        if (chunk.content) {
            this.response += chunk.content;
            assistantMessage.content = this.response;
            const lastPart = assistantMessage.parts[assistantMessage.parts.length - 1];
            if (lastPart && lastPart.type === 'text') {
                lastPart.content += chunk.content;
            } else {
                assistantMessage.parts.push(createTextPart(chunk.content));
            }
        }

        if (chunk.toolCallDeltas?.length) {
            for (const toolCallDelta of chunk.toolCallDeltas) {
                this.widgets.handleToolCallDelta(
                    this.snapshot.sessionHistory,
                    assistantMessage.id,
                    toolCallDelta
                );
            }
        }

        if (chunk.done && chunk.toolCalls?.length) {
            for (const toolCall of chunk.toolCalls) {
                this.widgets.processFinishedToolCall(
                    this.snapshot.sessionHistory,
                    assistantMessage.id,
                    toolCall
                );
            }
        }

        if (chunk.toolEvent) {
            this.handleToolEvent(assistantMessage, chunk.toolEvent);
        }

        this.touch();
        this.publish();
    }

    /**
     * 把已在工具边界投递的插队消息从待发送区转成普通用户消息。
     *
     * 当前 assistant 气泡先收口，用户消息插在它和下一段 assistant 输出之间；
     * 随后的模型增量会进入新的流式气泡。
     */
    deliverPendingUserMessages(messages: DeliveredPendingUserMessage[]): void {
        if (messages.length === 0) {
            return;
        }

        // 只转换仍处于待发区的消息。事件重复到达时不能再次插入，
        // 否则同一个气泡会在历史里出现两次。
        const pendingIds = new Set(this.snapshot.pendingUserMessages.map((message) => message.id));
        const deliveredMessages = messages.filter((message) => pendingIds.has(message.id));
        if (deliveredMessages.length === 0) {
            return;
        }

        const deliveredIds = new Set(deliveredMessages.map((message) => message.id));
        this.snapshot.pendingUserMessages = this.snapshot.pendingUserMessages.filter(
            (message) => !deliveredIds.has(message.id)
        );

        const assistantMessage = this.getActiveAssistantMessage();
        if (assistantMessage) {
            this.clearPendingCompaction(assistantMessage);
            this.finishReasoningPart(assistantMessage);
            assistantMessage.isStreaming = false;
            if (!this.hasVisibleAssistantContent(assistantMessage)) {
                this.removeSessionMessageById(assistantMessage.id);
            }
        }

        for (const message of deliveredMessages) {
            const snapshot = createInputHistorySnapshot({
                text: message.prompt,
                attachments: message.attachments,
                editorDoc: message.inputSnapshot?.editorDoc,
                excludeFromHistory: message.inputSnapshot?.excludeFromHistory,
            });
            this.snapshot.sessionHistory.push({
                id: message.id,
                role: 'user',
                content: message.prompt,
                attachments: message.attachments.length
                    ? cloneValue(message.attachments)
                    : undefined,
                inputSnapshot: cloneInputHistorySnapshot(snapshot) ?? undefined,
                parts: [],
                timestamp: Date.now(),
            });
        }

        this.response = '';
        this.reasoning = '';
        this.createStreamingAssistantMessage();
        this.touch();
        this.publish();
    }

    markCompleted(): void {
        this.widgets.resetTransientState();
        const assistantMessage = this.getActiveAssistantMessage();
        if (assistantMessage) {
            this.clearPendingCompaction(assistantMessage);
            this.finishReasoningPart(assistantMessage);
            assistantMessage.isStreaming = false;
        }

        this.snapshot.status = 'completed';
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    markFailed(errorMessage: string, displayMessage = errorMessage): void {
        this.widgets.resetTransientState();
        const statusText = tt('请求失败: {error}', { error: displayMessage });
        let shouldCreateStandaloneStatus = true;
        const assistantMessage = this.getActiveAssistantMessage();
        if (assistantMessage) {
            this.clearPendingCompaction(assistantMessage);
            this.finishReasoningPart(assistantMessage);
            const shouldKeepAssistantMessage = this.hasVisibleAssistantContent(assistantMessage);
            if (shouldKeepAssistantMessage) {
                assistantMessage.isStreaming = false;
                attachStatusText(assistantMessage, statusText);
                shouldCreateStandaloneStatus = false;
            } else {
                this.removeSessionMessageById(assistantMessage.id);
            }
        }

        if (shouldCreateStandaloneStatus) {
            this.snapshot.sessionHistory.push(
                createDerivedStatusMessage(statusText, {
                    isError: true,
                })
            );
        }
        this.snapshot.status = 'failed';
        this.snapshot.error = displayMessage;
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    markCancelled(): void {
        this.widgets.resetTransientState();
        const cancellationText = tt('请求已取消');
        this.markActiveToolCallsCancelled(cancellationText);

        let shouldCreateStandaloneStatus = true;
        const assistantMessage = this.getActiveAssistantMessage();
        if (assistantMessage) {
            this.clearPendingCompaction(assistantMessage);
            this.finishReasoningPart(assistantMessage);
            const shouldKeepAssistantMessage = this.hasVisibleAssistantContent(assistantMessage);
            if (!shouldKeepAssistantMessage) {
                this.removeSessionMessageById(assistantMessage.id);
            } else {
                assistantMessage.isStreaming = false;
                attachStatusText(assistantMessage, cancellationText);
                shouldCreateStandaloneStatus = false;
            }
        }

        if (shouldCreateStandaloneStatus && this.snapshot.sessionHistory.length > 0) {
            this.snapshot.sessionHistory.push(
                createDerivedStatusMessage(cancellationText, {
                    isCancelled: true,
                })
            );
        }

        this.snapshot.status = 'cancelled';
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    syncTaskMetadata(event: RuntimeTurnEvent): void {
        if (event.type === 'task_started') {
            this.snapshot.sessionId = event.sessionId;
            this.snapshot.turnId = event.turnId;
            this.snapshot.currentModel = event.model;
            this.snapshot.error = null;
            this.snapshot.status = this.interactions.hasPending ? 'waiting_approval' : 'running';
            this.touch();
            this.publish();
            return;
        }

        if (event.type === 'checkpoint_committed') {
            this.captureCheckpointPresentation();
            this.touch();
            this.publish();
            return;
        }

        if (event.type === 'retry_scheduled') {
            this.snapshot.status = this.interactions.hasPending ? 'waiting_approval' : 'running';
            this.touch();
            this.publish();
            return;
        }

        if (event.type === 'user_messages_delivered') {
            this.deliverPendingUserMessages(event.messages);
            return;
        }

        if (event.type === 'task_completed') {
            this.snapshot.turnId = event.turnId;
            this.snapshot.currentModel = event.model;
            this.markCompleted();
            return;
        }

        if (event.type === 'task_failed') {
            this.snapshot.turnId = event.turnId;
            this.markFailed(event.error, AiError.getKnownDefaultDisplayMessage(event.error));
            return;
        }

        if (event.type === 'task_cancelled') {
            this.snapshot.turnId = event.turnId;
            this.markCancelled();
        }
    }

    // ────────────────────── 消息管理 ──────────────────────

    private getActiveAssistantMessage(): SessionMessage | undefined {
        if (!this.activeAssistantMessageId) {
            return undefined;
        }

        return this.snapshot.sessionHistory.find(
            (message) =>
                message.id === this.activeAssistantMessageId && message.role === 'assistant'
        );
    }

    private createStreamingAssistantMessage(): SessionMessage {
        const message: SessionMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            parts: [],
            timestamp: Date.now(),
            isStreaming: true,
        };

        this.snapshot.sessionHistory.push(message);
        this.activeAssistantMessageId = message.id;
        return message;
    }

    private captureCheckpointPresentation(): void {
        this.lastCheckpointPresentation = {
            sessionHistory: cloneValue(this.snapshot.sessionHistory),
            activeAssistantMessageId: this.activeAssistantMessageId,
            response: this.response,
            reasoning: this.reasoning,
        };
    }

    private restoreCheckpointPresentation(): boolean {
        if (!this.lastCheckpointPresentation) {
            return false;
        }

        this.snapshot.sessionHistory = cloneValue(this.lastCheckpointPresentation.sessionHistory);
        this.activeAssistantMessageId = this.lastCheckpointPresentation.activeAssistantMessageId;
        this.response = this.lastCheckpointPresentation.response;
        this.reasoning = this.lastCheckpointPresentation.reasoning;
        this.widgets.resetTransientState();
        return true;
    }

    private removeSessionMessageById(messageId: string): void {
        this.snapshot.sessionHistory = this.snapshot.sessionHistory.filter(
            (message) => message.id !== messageId
        );

        if (this.activeAssistantMessageId === messageId) {
            this.activeAssistantMessageId = null;
        }
    }

    private hasVisibleAssistantContent(message: SessionMessage): boolean {
        if (message.content.trim() || message.reasoning?.trim()) {
            return true;
        }

        const approvalCallIds = new Set(
            (message.approvals ?? []).map((approval) => approval.callId)
        );
        const widgetIds = new Set((message.widgets ?? []).map((widget) => widget.widgetId));
        const widgetBackedToolCallIds = new Set(
            (message.widgets ?? []).map((widget) => widget.callId)
        );

        return message.parts.some((part) => {
            if (part.type === 'context_compaction') return part.state === 'compacted';
            if (part.type === 'text' || part.type === 'reasoning') {
                return !!part.content.trim();
            }

            if (part.type === 'tool_call') {
                return (
                    !this.widgets.isHiddenBuiltinToolCall(part.toolCall.namespacedName) &&
                    !widgetBackedToolCallIds.has(part.toolCall.id)
                );
            }

            if (part.type === 'approval') {
                return approvalCallIds.has(part.callId);
            }

            return widgetIds.has(part.widgetId);
        });
    }

    // ────────────────────── 状态同步 ──────────────────────

    private touch(): void {
        this.snapshot.pendingToolApproval = cloneValue(this.interactions.pendingApproval);
        this.snapshot.pendingApprovals = cloneValue(this.interactions.pendingApprovals);
        this.snapshot.pendingUserQuestion = cloneValue(this.interactions.pendingQuestion);
        this.snapshot.updatedAt = Date.now();
    }

    private syncPendingApprovalState(): void {
        if (isTerminalStatus(this.snapshot.status)) {
            return;
        }

        this.snapshot.status = this.interactions.hasPending ? 'waiting_approval' : 'running';
    }

    // ────────────────────── 跨关注点编排 ──────────────────────

    private buildSettlementResult(
        display: PendingToolApproval,
        approved: boolean,
        resolutionText?: string
    ): ApprovalSettlementResult {
        const text = resolveApprovalResolutionText(approved, resolutionText);
        return {
            target: display,
            approved,
            resolutionText: text,
            isCancellationResolution: !approved && isCancellationStatusText(text),
        };
    }

    private collectDisplayedApprovalSettlements(
        reason: string,
        settledCallIds: Set<string>
    ): ApprovalSettlementResult[] {
        const results: ApprovalSettlementResult[] = [];
        const isCancellationResolution = isCancellationStatusText(reason);

        for (const message of this.snapshot.sessionHistory) {
            if (message.role !== 'assistant' || !message.approvals?.length) {
                continue;
            }

            for (const approval of message.approvals) {
                if (approval.status !== 'pending' || settledCallIds.has(approval.callId)) {
                    continue;
                }

                settledCallIds.add(approval.callId);
                results.push({
                    target: this.buildPendingApprovalTarget(message.id, approval),
                    approved: false,
                    resolutionText: reason,
                    isCancellationResolution,
                });
            }
        }

        return results;
    }

    private buildPendingApprovalTarget(
        messageId: string,
        approval: ToolApprovalInfo
    ): PendingToolApproval {
        return {
            callId: approval.callId,
            messageId,
            title: approval.title,
            description: approval.description,
            command: approval.command,
            riskLabel: approval.riskLabel,
            reason: approval.reason,
            approveLabel: approval.approveLabel,
            rejectLabel: approval.rejectLabel,
            enterHint: approval.enterHint,
            escHint: approval.escHint,
            keyboardApproveAt: approval.keyboardApproveAt,
        };
    }

    private applyApprovalSettlement(result: ApprovalSettlementResult): void {
        const { target, approved, isCancellationResolution } = result;
        const resolutionText = isCancellationResolution ? tt('请求已取消') : result.resolutionText;

        updateToolCallStatus(
            this.snapshot.sessionHistory,
            target.messageId,
            target.callId,
            (toolCall) => {
                if (approved) {
                    toolCall.status = 'executing';
                    return;
                }

                toolCall.status = isCancellationResolution ? 'cancelled' : 'rejected';
                toolCall.isError = isCancellationResolution ? false : true;
                toolCall.result = resolutionText;
            }
        );

        if (approved) {
            removeToolApproval(this.snapshot.sessionHistory, target.messageId, target.callId);
        } else {
            updateToolApproval(
                this.snapshot.sessionHistory,
                target.messageId,
                target.callId,
                (approval) => {
                    approval.status = isCancellationResolution ? 'cancelled' : 'rejected';
                    approval.resolutionText = resolutionText;
                }
            );
        }
    }

    /**
     * 批量标记活跃工具调用为已取消。
     *
     * 横跨工具调用和 widget 两个子关注点：
     * 先通过 widget 管理器清理草稿，再更新工具调用状态。
     */
    private markActiveToolCallsCancelled(cancellationText: string): void {
        for (const message of this.snapshot.sessionHistory) {
            if (message.role !== 'assistant') {
                continue;
            }

            for (const toolCall of selectToolCalls(message)) {
                const shouldMarkCancelled =
                    toolCall.status === 'executing' ||
                    toolCall.status === 'awaiting_approval' ||
                    ((toolCall.status === 'rejected' || toolCall.status === 'error') &&
                        isCancellationStatusText(toolCall.result));

                if (!shouldMarkCancelled) {
                    continue;
                }

                this.widgets.finalizeToolCall(this.snapshot.sessionHistory, toolCall.id, {
                    removeDraft: true,
                });
                toolCall.status = 'cancelled';
                toolCall.isError = false;
                toolCall.result = cancellationText;
                syncBuiltInToolCallPresentation(toolCall);
            }
        }
    }

    // ────────────────────── 事件路由 ──────────────────────

    private handleRetryEvent(
        assistantMessage: SessionMessage,
        toolEvent: Extract<ToolEvent, { type: 'request_retry' }>
    ): void {
        const retryStatusMessage = createDerivedStatusMessage(
            getRetryStatusMessage(toolEvent.attempt, toolEvent.maxRetries),
            { isRetrying: true }
        );

        if (toolEvent.retryScope === 'checkpoint') {
            const shouldRollbackCheckpointPresentation =
                toolEvent.discardVisibleOutputSinceCheckpoint ||
                toolEvent.discardToolActivitySinceCheckpoint;
            if (shouldRollbackCheckpointPresentation) {
                this.restoreCheckpointPresentation();
            }
            this.snapshot.sessionHistory.push(retryStatusMessage);
            this.snapshot.status = 'running';
            this.touch();
            this.publish();
            return;
        }

        const shouldKeepAssistantMessage = this.hasVisibleAssistantContent(assistantMessage);
        if (shouldKeepAssistantMessage) {
            assistantMessage.isStreaming = false;
        } else {
            this.removeSessionMessageById(assistantMessage.id);
        }

        this.response = '';
        this.reasoning = '';
        this.snapshot.sessionHistory.push(retryStatusMessage);
        this.createStreamingAssistantMessage();
        this.snapshot.status = 'running';
        this.touch();
        this.publish();
    }

    private handleToolEvent(message: SessionMessage, toolEvent: ToolEvent): void {
        if (toolEvent.type === 'call_start') {
            upsertToolCall(message, toolEvent);
            return;
        }

        if (toolEvent.type === 'approval_required') {
            this.userPrompts.presentApproval(this.snapshot.sessionHistory, message.id, {
                callId: toolEvent.callId,
                title: toolEvent.title,
                description: toolEvent.description,
                command: toolEvent.command,
                riskLabel: toolEvent.riskLabel,
                reason: toolEvent.reason,
                commandLabel: toolEvent.commandLabel,
                approveLabel: toolEvent.approveLabel,
                rejectLabel: toolEvent.rejectLabel,
                enterHint: toolEvent.enterHint,
                escHint: toolEvent.escHint,
                keyboardApproveDelayMs: toolEvent.keyboardApproveDelayMs,
            });
            return;
        }

        if (toolEvent.type === 'approval_resolved') {
            // Display-only echo. The actual decision settled through the task owner
            // with a captured identity; this echo must never fabricate one to authorize.
            return;
        }

        if (toolEvent.type === 'result_delta') {
            updateToolCallStatus(
                this.snapshot.sessionHistory,
                message.id,
                toolEvent.callId,
                (toolCall) => {
                    toolCall.result = toolEvent.result;
                }
            );
            return;
        }

        if (toolEvent.type === 'widget_upsert') {
            this.widgets.upsertWidget(this.snapshot.sessionHistory, message.id, toolEvent);
            return;
        }

        if (toolEvent.type === 'widget_remove') {
            this.widgets.removeWidgetByWidgetId(
                this.snapshot.sessionHistory,
                toolEvent.widgetId,
                message.id
            );
            return;
        }

        if (toolEvent.type === 'call_end') {
            this.widgets.finalizeToolCall(this.snapshot.sessionHistory, toolEvent.callId, {
                removeDraft: toolEvent.isError || toolEvent.finalStatus === 'rejected',
            });
            updateToolCallStatus(
                this.snapshot.sessionHistory,
                message.id,
                toolEvent.callId,
                (toolCall) => {
                    toolCall.result = toolEvent.result;
                    toolCall.isError = toolEvent.isError;
                    if (toolEvent.structuredPayload) {
                        toolCall.structuredPayload = toolEvent.structuredPayload;
                    }
                    if (toolEvent.builtinConversationSemantic) {
                        toolCall.builtinConversationSemantic =
                            toolEvent.builtinConversationSemantic;
                    }
                    if (toolEvent.finalStatus === 'rejected') {
                        toolCall.status = 'rejected';
                    } else {
                        toolCall.status = toolEvent.isError ? 'error' : 'completed';
                    }
                    toolCall.durationMs = toolEvent.durationMs;
                }
            );
            this.syncPendingApprovalState();
            return;
        }

        if (toolEvent.type === 'model_switched') {
            this.snapshot.currentModel = createTaskModelFromToolEvent(
                toolEvent.toModel,
                this.snapshot.currentModel
            );
            this.snapshot.modelSwitchCount += 1;
        }
    }
}
