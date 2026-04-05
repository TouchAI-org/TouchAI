// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 任务投影器（协调层）。
 *
 * 负责把底层运行事件整理成 UI 可直接消费的任务快照。
 * Widget、审批、工具调用三个子关注点分别由同目录下的对应模块承载，
 * 本文件只保留核心生命周期、消息管理和跨子关注点的编排逻辑。
 */

import type { PendingToolApproval, SessionMessage, ToolApprovalInfo } from '@/types/session';
import { createTextPart } from '@/utils/session';

import type { AiStreamChunk } from '../../contracts/protocol';
import type { ToolApprovalDecisionRequest, ToolEvent } from '../../contracts/tooling';
import type { TurnEvent } from '../../execution';
import { getRetryStatusMessage } from '../../execution/retry';
import type { SessionTaskSnapshot, StartSessionTaskOptions } from '../types';
import {
    type ApprovalSettlementResult,
    ProjectionApprovals,
    removeToolApproval,
    updateToolApproval,
} from './approvals';
import {
    attachStatusText,
    cloneValue,
    createDerivedStatusMessage,
    createTaskModelFromToolEvent,
    isCancellationStatusText,
    isTerminalStatus,
} from './helpers';
import {
    ensureToolCallPart,
    syncBuiltInToolCallPresentation,
    updateToolCallStatus,
    upsertToolCall,
} from './toolCalls';
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

    private readonly widgets = new ProjectionWidgets();
    private readonly approvals = new ProjectionApprovals();

    constructor(
        private readonly snapshot: SessionTaskSnapshot,
        private readonly publish: () => void
    ) {}

    // ────────────────────── 公共 API ──────────────────────

    bootstrap(
        history: SessionMessage[],
        prompt: string,
        attachments: StartSessionTaskOptions['attachments']
    ): void {
        this.snapshot.sessionHistory = cloneValue(history);
        this.snapshot.sessionHistory.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: prompt,
            attachments: attachments?.length ? cloneValue(attachments) : undefined,
            parts: [],
            timestamp: Date.now(),
        });

        this.createStreamingAssistantMessage();
        this.snapshot.status = 'running';
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    getPendingToolApproval(): PendingToolApproval | null {
        return this.approvals.getPending();
    }

    approvePendingToolApproval(callId?: string): boolean {
        const targetCallId = callId ?? this.approvals.getPending()?.callId;
        if (!targetCallId) {
            return false;
        }

        return this.settlePendingApproval(targetCallId, true);
    }

    rejectPendingToolApproval(callId?: string): boolean {
        const targetCallId = callId ?? this.approvals.getPending()?.callId;
        if (!targetCallId) {
            return false;
        }

        return this.settlePendingApproval(targetCallId, false);
    }

    clearPendingApprovals(reason = '请求已取消'): void {
        const results = this.approvals.clearAll(reason);
        const settledCallIds = new Set(results.map((result) => result.target.callId));
        for (const result of results) {
            this.applyApprovalSettlement(result);
        }
        for (const result of this.collectDisplayedApprovalSettlements(reason, settledCallIds)) {
            this.applyApprovalSettlement(result);
        }
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    requestToolApproval(payload: ToolApprovalDecisionRequest): Promise<boolean> {
        const existingApproval = this.findToolApproval(payload.callId);
        if (existingApproval && existingApproval.status !== 'pending') {
            return Promise.resolve(false);
        }

        const assistantMessage = this.getActiveAssistantMessage();
        if (!assistantMessage) {
            return Promise.resolve(false);
        }

        const promise = this.approvals.requestApproval(
            this.snapshot.sessionHistory,
            assistantMessage.id,
            payload
        );
        if (!promise) {
            return Promise.resolve(false);
        }

        updateToolCallStatus(
            this.snapshot.sessionHistory,
            assistantMessage.id,
            payload.callId,
            (toolCall) => {
                toolCall.status = 'awaiting_approval';
            }
        );

        this.syncPendingApprovalState();
        this.touch();
        this.publish();

        return promise;
    }

    handleChunk(chunk: AiStreamChunk): void {
        const assistantMessage = this.getActiveAssistantMessage();
        if (!assistantMessage) {
            return;
        }

        if (chunk.toolEvent?.type === 'request_retry') {
            this.handleRetryEvent(assistantMessage, chunk.toolEvent);
            return;
        }

        if (chunk.reasoning) {
            this.reasoning += chunk.reasoning;
            assistantMessage.reasoning = this.reasoning;
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

    markCompleted(): void {
        const assistantMessage = this.getActiveAssistantMessage();
        if (assistantMessage) {
            assistantMessage.isStreaming = false;
        }

        this.snapshot.status = 'completed';
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    markFailed(errorMessage: string): void {
        const statusText = `请求失败: ${errorMessage}`;
        let shouldCreateStandaloneStatus = true;
        const assistantMessage = this.getActiveAssistantMessage();
        if (assistantMessage) {
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
        this.snapshot.error = errorMessage;
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    markCancelled(): void {
        this.markActiveToolCallsCancelled('请求已取消');

        let shouldCreateStandaloneStatus = true;
        const assistantMessage = this.getActiveAssistantMessage();
        if (assistantMessage) {
            const shouldKeepAssistantMessage = this.hasVisibleAssistantContent(assistantMessage);
            if (!shouldKeepAssistantMessage) {
                this.removeSessionMessageById(assistantMessage.id);
            } else {
                assistantMessage.isStreaming = false;
                attachStatusText(assistantMessage, '请求已取消');
                shouldCreateStandaloneStatus = false;
            }
        }

        if (shouldCreateStandaloneStatus && this.snapshot.sessionHistory.length > 0) {
            this.snapshot.sessionHistory.push(
                createDerivedStatusMessage('请求已取消', {
                    isCancelled: true,
                })
            );
        }

        this.snapshot.status = 'cancelled';
        this.syncPendingApprovalState();
        this.touch();
        this.publish();
    }

    syncTaskMetadata(event: TurnEvent): void {
        if (event.type === 'task_started') {
            this.snapshot.sessionId = event.sessionId;
            this.snapshot.turnId = event.turnId;
            this.snapshot.currentModel = event.model;
            this.snapshot.error = null;
            this.snapshot.status = this.approvals.hasPending ? 'waiting_approval' : 'running';
            this.touch();
            this.publish();
            return;
        }

        if (event.type === 'prompt_snapshot_ready') {
            this.snapshot.promptSnapshot = event.snapshot;
            this.touch();
            this.publish();
            return;
        }

        if (event.type === 'checkpoint_committed') {
            this.snapshot.lastCheckpoint = cloneValue(event.checkpoint);
            this.captureCheckpointPresentation();
            this.touch();
            this.publish();
            return;
        }

        if (event.type === 'retry_scheduled') {
            this.snapshot.lastCheckpoint = cloneValue(event.checkpoint);
            this.snapshot.status = this.approvals.hasPending ? 'waiting_approval' : 'running';
            this.touch();
            this.publish();
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
            this.markFailed(event.error);
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

    private findToolApproval(callId: string): ToolApprovalInfo | undefined {
        for (const message of this.snapshot.sessionHistory) {
            if (message.role !== 'assistant') {
                continue;
            }

            const approval = message.approvals?.find((item) => item.callId === callId);
            if (approval) {
                return approval;
            }
        }

        return undefined;
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

        const toolCallMap = new Map(
            (message.toolCalls ?? []).map((toolCall) => [toolCall.id, toolCall])
        );
        const approvalCallIds = new Set(
            (message.approvals ?? []).map((approval) => approval.callId)
        );
        const widgetIds = new Set((message.widgets ?? []).map((widget) => widget.widgetId));
        const widgetBackedToolCallIds = new Set(
            (message.widgets ?? []).map((widget) => widget.callId)
        );

        return message.parts.some((part) => {
            if (part.type === 'text') {
                return !!part.content.trim();
            }

            if (part.type === 'tool_call') {
                const toolCall = toolCallMap.get(part.callId);
                return (
                    !!toolCall &&
                    !this.widgets.isHiddenBuiltinToolCall(toolCall.namespacedName) &&
                    !widgetBackedToolCallIds.has(part.callId)
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
        this.snapshot.pendingToolApproval = cloneValue(this.approvals.getPending());
        this.snapshot.pendingApprovals = cloneValue([...this.approvals.pendingQueue]);
        this.snapshot.updatedAt = Date.now();
    }

    private syncPendingApprovalState(): void {
        if (isTerminalStatus(this.snapshot.status)) {
            return;
        }

        this.snapshot.status = this.approvals.hasPending ? 'waiting_approval' : 'running';
    }

    // ────────────────────── 跨关注点编排 ──────────────────────

    /**
     * 结算审批并同步工具调用状态。
     *
     * 审批队列状态由 `ProjectionApprovals` 管理，
     * 工具调用状态和消息中的审批卡片由本方法跨模块协调。
     */
    private settlePendingApproval(callId: string, approved: boolean): boolean {
        const settled = this.settleApproval(callId, approved);
        if (!settled) {
            return false;
        }
        this.touch();
        this.publish();
        return true;
    }

    private settleApproval(
        callId: string,
        approved: boolean,
        options: { resolutionText?: string } = {}
    ): boolean {
        const result = this.approvals.settle(callId, approved, options);
        if (!result) {
            return false;
        }

        this.applyApprovalSettlement(result);
        this.syncPendingApprovalState();
        return true;
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
        const { target, approved, resolutionText, isCancellationResolution } = result;

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
            if (message.role !== 'assistant' || !message.toolCalls?.length) {
                continue;
            }

            for (const toolCall of message.toolCalls) {
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
            if (!this.widgets.isHiddenBuiltinToolCall(toolEvent.namespacedName)) {
                ensureToolCallPart(message, toolEvent.callId);
            }
            return;
        }

        if (toolEvent.type === 'approval_required') {
            this.approvals.presentApproval(this.snapshot.sessionHistory, message.id, {
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
            this.settleApproval(toolEvent.callId, toolEvent.approved, {
                resolutionText: toolEvent.resolutionText,
            });
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
                    if (toolEvent.finalStatus === 'rejected') {
                        toolCall.status = 'rejected';
                    } else {
                        toolCall.status = toolEvent.isError ? 'error' : 'completed';
                    }
                    toolCall.durationMs = toolEvent.durationMs;
                }
            );
            this.approvals.cleanup(toolEvent.callId);
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
