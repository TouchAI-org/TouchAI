// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    createAiRequest,
    createMessage,
    createMessageAttachment,
    createSession,
    updateAiRequest,
    updateSession,
} from '@database/queries';
import type { MessageRole, RequestStatus } from '@database/schema';
import type { AiRequestEntity, AiRequestUpdateData } from '@database/types';
import { ensurePersistedAttachmentIndex, type Index } from '@services/AiService/attachments';

interface PersisterModel {
    id: number;
    model_id: string;
    provider_id: number;
}

interface PersisterOptions {
    prompt: string;
    attachments?: Index[];
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
    private readonly attachments: Index[];
    private readonly model: PersisterModel;
    private readonly buildSessionTitle: (prompt: string) => string;

    private sessionId: number | null;

    private userMessageId: number | null;
    private assistantMessageId: number | null;
    private request: AiRequestEntity | null;

    constructor(options: PersisterOptions) {
        this.prompt = options.prompt;
        this.attachments = options.attachments ?? [];
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
        await this.syncSessionIdentity();

        if (!this.userMessageId) {
            this.userMessageId = await this.persistMessage(
                'user',
                this.prompt,
                null,
                this.attachments
            );
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
                provider_id: this.model.provider_id,
            });

            this.sessionId = session.id;
            return session.id;
        } catch (sessionError) {
            console.error('[Persister] Failed to create session:', sessionError);
            return null;
        }
    }

    /**
     * useAgent 可能会先按“当前选中的标签”预创建会话，
     * 等真正解析出默认模型后，再由持久化层把 session 的 model/provider 校准成最终值。
     */
    private async syncSessionIdentity(): Promise<void> {
        if (!this.sessionId) {
            return;
        }

        try {
            await updateSession({
                id: this.sessionId,
                sessionPatch: {
                    model: this.model.model_id,
                    provider_id: this.model.provider_id,
                },
            });
        } catch (error) {
            console.error('[Persister] Failed to sync session identity:', error);
        }
    }

    private async persistMessage(
        role: MessageRole,
        content: string,
        toolLogId?: number | null,
        attachments: Index[] = []
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

        if (role === 'user' && attachments.length > 0) {
            const persisted = await Promise.all(
                attachments.map((attachment) => ensurePersistedAttachmentIndex(attachment))
            );

            for (const [index, entity] of persisted.entries()) {
                await createMessageAttachment({
                    message_id: message.id,
                    attachment_id: entity.id,
                    sort_order: index,
                });
            }
        }

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
