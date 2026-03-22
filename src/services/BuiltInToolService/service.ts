// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    createBuiltInToolLog,
    findBuiltInToolByToolId,
    findEnabledBuiltInTools,
    touchBuiltInToolLastUsed,
    updateBuiltInToolLogByCallId,
} from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import type { ToolLogKind } from '@database/schema';
import type {
    AiToolCall,
    AiToolDefinition,
    ToolApprovalDecisionRequest,
    ToolApprovalRequest,
    ToolEvent,
} from '@services/AiService/types';

import { builtInToolRegistry } from './registry';
import type {
    BaseBuiltInToolExecutionContext,
    BuiltInToolControlSignal,
    BuiltInToolExecutionResult,
    BuiltInToolId,
    ResolvedBuiltInToolCall,
} from './types';

const BUILT_IN_TOOL_PREFIX = 'builtin__';

interface BuiltInToolExecutionOptions {
    toolCall: AiToolCall;
    toolArgs: Record<string, unknown>;
    iteration: number;
    currentModel: ModelWithProvider;
    hasExecutedBuiltInTool: (toolId: BuiltInToolId) => boolean;
    signal?: AbortSignal;
    sessionId: number | null;
    toolCallMessageId: number | null;
    requestToolApproval?: (payload: ToolApprovalDecisionRequest) => Promise<boolean>;
    emitToolEvent: (event: ToolEvent) => void;
}

interface BuiltInToolExecutionResponse {
    toolCall: AiToolCall;
    builtInToolId: BuiltInToolId;
    result: string;
    isError: boolean;
    toolLogId: number | null;
    toolLogKind: ToolLogKind;
    controlSignal?: BuiltInToolControlSignal;
}

/**
 * 内置工具服务。
 */
class BuiltInToolService {
    /**
     * 生成当前可暴露给模型的内置工具定义。
     *
     * @returns 仅包含“已启用且已注册”工具的定义列表。
     */
    async getEnabledToolDefinitions(): Promise<AiToolDefinition[]> {
        const enabledTools = await findEnabledBuiltInTools();
        return enabledTools.flatMap((tool) => {
            const descriptor = builtInToolRegistry.get(tool.tool_id);
            if (!descriptor) {
                return [];
            }

            return [
                {
                    name: `${BUILT_IN_TOOL_PREFIX}${tool.tool_id}`,
                    description: descriptor.description,
                    input_schema: descriptor.inputSchema,
                },
            ];
        });
    }

    /**
     * 将模型返回的工具名解析为可执行的内置工具调用。
     *
     * @param toolName 模型返回的带命名空间工具名。
     * @returns 已解析的调用信息；不是内置工具或未启用时返回 `null`。
     */
    async resolveToolCall(toolName: string): Promise<ResolvedBuiltInToolCall | null> {
        if (!toolName.startsWith(BUILT_IN_TOOL_PREFIX)) {
            return null;
        }

        const toolId = toolName.slice(BUILT_IN_TOOL_PREFIX.length);
        const entity = await findBuiltInToolByToolId(toolId);
        if (!entity || entity.enabled !== 1) {
            return null;
        }

        const tool = builtInToolRegistry.get(toolId);
        if (!tool) {
            return null;
        }

        return {
            entity,
            tool,
            // 无持久化配置的工具直接复用描述符默认值；
            // 真正需要从数据库反序列化时，才通过 parseConfig 进入各自工具的配置边界。
            config: tool.parseConfig(entity.config_json),
            namespacedName: toolName,
        };
    }

    /**
     * 为已解析的工具调用构造审批请求。
     *
     * @param resolved 已解析的工具调用。
     * @param args 工具参数。
     * @param context 运行时上下文。
     * @returns 审批请求；该工具无需审批时返回 `null`。
     */
    async buildApprovalRequest(
        resolved: ResolvedBuiltInToolCall,
        args: Record<string, unknown>,
        context: BaseBuiltInToolExecutionContext
    ): Promise<ToolApprovalRequest | null> {
        return await resolved.tool.buildApprovalRequest(
            args,
            resolved.config,
            resolved.namespacedName,
            context
        );
    }

    /**
     * 执行具体工具，并回写最后使用时间。
     *
     * @param resolved 已解析的工具调用。
     * @param args 工具参数。
     * @param context 运行时上下文。
     * @returns 工具执行结果。
     */
    async executeResolvedTool(
        resolved: ResolvedBuiltInToolCall,
        args: Record<string, unknown>,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        const result = await resolved.tool.execute(args, resolved.config, context);
        await touchBuiltInToolLastUsed(resolved.entity.tool_id);
        return result;
    }

    /**
     * 统一执行 built-in tool 的完整生命周期。
     *
     */
    async executeTool(
        options: BuiltInToolExecutionOptions
    ): Promise<BuiltInToolExecutionResponse | null> {
        // 1. 解析成可执行的工具
        const resolved = await this.resolveToolCall(options.toolCall.name);
        if (!resolved) {
            return null;
        }

        // 2. 为工具构造执行上下文。
        const executionContext: BaseBuiltInToolExecutionContext = {
            callId: options.toolCall.id,
            iteration: options.iteration,
            currentModel: options.currentModel,
            signal: options.signal,
            emitToolEvent: options.emitToolEvent,
            hasExecutedBuiltInTool: options.hasExecutedBuiltInTool,
        };

        const callStartTime = Date.now();
        // `call_start` 要尽早发给 UI，前端可展示工具调用开始了
        options.emitToolEvent({
            type: 'call_start',
            callId: options.toolCall.id,
            toolName: resolved.tool.displayName,
            namespacedName: options.toolCall.name,
            source: 'builtin',
            sourceLabel: '内置工具',
            arguments: options.toolArgs,
        });

        let toolLogId: number | null = null;
        try {
            // 3. 新建 pending 日志
            const toolLog = await createBuiltInToolLog({
                tool_id: resolved.entity.tool_id,
                tool_call_id: options.toolCall.id,
                session_id: options.sessionId,
                message_id: options.toolCallMessageId,
                iteration: options.iteration,
                input: JSON.stringify(options.toolArgs),
                status: 'pending',
                approval_state: 'none',
            });
            toolLogId = toolLog.id;
        } catch (error) {
            console.error('[BuiltInToolService] Failed to create built-in tool log:', error);
        }

        // 4. 如果需要审批，先走审批。
        const approvalRequest = await this.buildApprovalRequest(
            resolved,
            options.toolArgs,
            executionContext
        );
        if (approvalRequest) {
            options.emitToolEvent({
                type: 'approval_required',
                callId: options.toolCall.id,
                ...approvalRequest,
            });

            // 审批事件和日志状态要同步切到 pending，
            // 这样数据库里的状态能和前端“正在等待用户决定”的 UI 保持一致。
            await updateBuiltInToolLogByCallId(options.toolCall.id, {
                status: 'awaiting_approval',
                approval_state: 'pending',
                approval_summary: approvalRequest.reason,
            }).catch((error) => {
                console.error(
                    '[BuiltInToolService] Failed to update built-in tool approval state:',
                    error
                );
            });

            const approved = options.requestToolApproval
                ? await options.requestToolApproval({
                      callId: options.toolCall.id,
                      ...approvalRequest,
                  })
                : false;
            const resolutionText = approved ? '已批准执行此命令' : '用户已拒绝执行此命令';

            options.emitToolEvent({
                type: 'approval_resolved',
                callId: options.toolCall.id,
                approved,
                resolutionText,
            });

            if (!approved) {
                const durationMs = Date.now() - callStartTime;
                await updateBuiltInToolLogByCallId(options.toolCall.id, {
                    status: 'rejected',
                    approval_state: 'rejected',
                    approval_summary: approvalRequest.reason,
                    duration_ms: durationMs,
                    error_message: resolutionText,
                }).catch((error) => {
                    console.error(
                        '[BuiltInToolService] Failed to update rejected built-in tool log:',
                        error
                    );
                });

                options.emitToolEvent({
                    type: 'call_end',
                    callId: options.toolCall.id,
                    result: resolutionText,
                    isError: true,
                    durationMs,
                    finalStatus: 'rejected',
                });

                // 被拒绝的工具调用也要产出一条结果文本，
                // 否则 assistant 已经发出的 tool_call 会在后续消息历史里悬空。
                return {
                    toolCall: options.toolCall,
                    builtInToolId: resolved.tool.id,
                    result: resolutionText,
                    isError: true,
                    toolLogId,
                    toolLogKind: 'builtin',
                };
            }

            // 审批通过后再把日志切到 approved，
            // 保证数据库只记录“已经落地的用户决策”，而不是中间态推测。
            await updateBuiltInToolLogByCallId(options.toolCall.id, {
                status: 'approved',
                approval_state: 'approved',
                approval_summary: approvalRequest.reason,
            }).catch((error) => {
                console.error(
                    '[BuiltInToolService] Failed to update approved built-in tool log:',
                    error
                );
            });
        }

        let toolResult: BuiltInToolExecutionResult;
        try {
            // 5. 执行工具
            toolResult = await this.executeResolvedTool(
                resolved,
                options.toolArgs,
                executionContext
            );
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(
                `[BuiltInToolService] Built-in tool execution failed: ${options.toolCall.name}`,
                error
            );
            toolResult = {
                result: `Tool execution failed: ${errorMessage}`,
                isError: true,
                status: 'error',
                errorMessage,
            };
        }

        const durationMs = Date.now() - callStartTime;
        // 同步结果
        options.emitToolEvent({
            type: 'call_end',
            callId: options.toolCall.id,
            result: toolResult.result,
            isError: toolResult.isError,
            durationMs,
            finalStatus: toolResult.status === 'success' ? 'completed' : 'error',
        });

        await updateBuiltInToolLogByCallId(options.toolCall.id, {
            output: toolResult.result,
            status:
                toolResult.status === 'success'
                    ? 'success'
                    : toolResult.status === 'timeout'
                      ? 'timeout'
                      : 'error',
            duration_ms: durationMs,
            error_message: toolResult.isError
                ? (toolResult.errorMessage ?? toolResult.result)
                : null,
        }).catch((error) => {
            console.error('[BuiltInToolService] Failed to update built-in tool log:', error);
        });

        return {
            toolCall: options.toolCall,
            builtInToolId: resolved.tool.id,
            result: toolResult.result,
            isError: toolResult.isError,
            toolLogId,
            toolLogKind: 'builtin',
            controlSignal: toolResult.controlSignal,
        };
    }
}

export const builtInToolService = new BuiltInToolService();
