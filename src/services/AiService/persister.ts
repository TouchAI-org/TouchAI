// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { createAiRequest, createMessage, createSession, updateAiRequest } from '@database/queries';
import type { MessageRole, RequestStatus } from '@database/schema';
import type { AiRequestEntity, AiRequestUpdateData } from '@database/types';

interface PersisterModel {
    id: number;
    model_id: string;
}

interface PersisterOptions {
    prompt: string;
    model: PersisterModel;
    sessionId?: number | null;
    buildSessionTitle: (prompt: string) => string;
}

interface CompleteRequestOptions {
    response: string;
    durationMs: number;
    tokensUsed?: number | null;
}

/**
 * 负责 AI 请求相关记录持久化：session、message、ai_request。
 *
 * 采用分阶段记录：
 * - begin: 写入 user message + 创建 streaming 请求记录
 * - completed: 写 assistant message + 更新请求状态
 * - failed/cancelled: 更新请求状态
 */
export class Persister {
    private readonly prompt: string;
    private readonly model: PersisterModel;
    private readonly buildSessionTitle: (prompt: string) => string;

    private sessionId: number | null;

    private userMessageId: number | null;
    private assistantMessageId: number | null;
    private request: AiRequestEntity | null;

    constructor(options: PersisterOptions) {
        this.prompt = options.prompt;
        this.model = options.model;
        this.buildSessionTitle = options.buildSessionTitle;

        this.sessionId = options.sessionId ?? null;
        this.userMessageId = null;
        this.assistantMessageId = null;
        this.request = null;
    }

    /**
     * 记录请求开始阶段：先记录用户消息，再创建 streaming 请求记录。
     */
    async recordRequestStart(): Promise<void> {
        if (!this.userMessageId) {
            this.userMessageId = await this.persistMessage('user', this.prompt);
        }

        await this.ensureRequestRecord();
    }

    /**
     * 请求成功阶段：记录 assistant 回复并更新请求状态。
     */
    async markCompleted(options: CompleteRequestOptions): Promise<void> {
        if (options.response.trim() && !this.assistantMessageId) {
            this.assistantMessageId = await this.persistMessage('assistant', options.response);
        }

        await this.patchRequest({
            status: 'completed',
            error_message: null,
            response_message_id: this.assistantMessageId,
            tokens_used: options.tokensUsed ?? null,
            duration_ms: options.durationMs,
        });
    }

    /**
     * 请求失败阶段：更新失败状态和错误信息。
     */
    async markFailed(errorMessage: string): Promise<void> {
        await this.patchRequest({
            status: 'failed',
            error_message: errorMessage,
        });
    }

    /**
     * 请求取消阶段：更新取消状态。
     */
    async markCancelled(): Promise<void> {
        await this.patchRequest({
            status: 'cancelled',
            error_message: 'Cancelled by user',
        });
    }

    /**
     * 获取当前请求记录（可能为 null）。
     */
    getRequest(): AiRequestEntity | null {
        return this.request;
    }

    /**
     * 获取当前会话 ID（可能为 null）。
     */
    getSessionId(): number | null {
        return this.sessionId;
    }

    /**
     * 持久化工具调用消息（role: 'tool_call'）
     */
    async persistToolCallMessage(text?: string): Promise<number | null> {
        return this.persistMessage('tool_call', text || '');
    }

    /**
     * 持久化工具结果消息（role: 'tool_result'）
     * @param toolLogId 对应 mcp_tool_logs 表的 ID
     */
    async persistToolResultMessage(
        result: string,
        toolLogId: number | null
    ): Promise<number | null> {
        return this.persistMessage('tool_result', result, toolLogId);
    }

    private async ensureSessionId(): Promise<number | null> {
        if (this.sessionId) {
            return this.sessionId;
        }
        try {
            const session = await createSession({
                session_id: crypto.randomUUID(),
                title: this.buildSessionTitle(this.prompt),
                model: this.model.model_id,
            });

            this.sessionId = session.id;
            return session.id;
        } catch (sessionError) {
            console.error('[Persister] Failed to create session:', sessionError);
            return null;
        }
    }

    private async persistMessage(
        role: MessageRole,
        content: string,
        toolLogId?: number | null
    ): Promise<number | null> {
        const sessionId = await this.ensureSessionId();

        if (!sessionId) {
            return null;
        }

        const message = await createMessage({
            session_id: sessionId,
            role: role as MessageRole,
            content,
            tool_log_id: toolLogId ?? null,
        });

        return message.id;
    }

    private async ensureRequestRecord(): Promise<void> {
        if (this.request) {
            return;
        }

        const sessionId = await this.ensureSessionId();

        this.request = await createAiRequest({
            session_id: sessionId,
            model_id: this.model.id,
            prompt_message_id: this.userMessageId,
            response_message_id: this.assistantMessageId,
            status: 'streaming' as RequestStatus,
        });
    }

    private async patchRequest(patch: AiRequestUpdateData): Promise<void> {
        if (!this.request) {
            await this.ensureRequestRecord();
        }

        if (!this.request) {
            return;
        }

        try {
            await updateAiRequest({
                id: this.request.id,
                requestPatch: patch,
            });
            this.request = {
                ...this.request,
                ...patch,
            };
        } catch (persistError) {
            console.error('[Persister] Failed to update ai_request record:', persistError);
        }
    }
}
