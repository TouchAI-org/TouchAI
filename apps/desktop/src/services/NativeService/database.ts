// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import type { SqlValue } from '@database/schema';

import { invoke } from './invoke';

export type ToolPartKind = 'mcp' | 'builtin';
export type ToolPartFilter =
    | { kind: 'id'; id: number }
    | { kind: 'tool_call_id'; toolCallId: string }
    | { kind: 'server_id'; serverId: number }
    | { kind: 'tool_id'; toolId: string };

export interface DatabaseAttachmentInput {
    attachmentId?: number | null;
    hash?: string | null;
    type: 'image' | 'file';
    originalName: string;
    originPath: string;
    mimeType?: string | null;
    size?: number | null;
}

export interface DatabaseOutputPartInput {
    type: 'text' | 'reasoning';
    content: string;
    data?: string;
    startedAt?: number | null;
    endedAt?: number | null;
}

export interface DatabaseLlmCallPartInput {
    data: string;
    startedAt?: number | null;
    endedAt?: number | null;
}

export interface DatabaseUsageSummary {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalCostMicros: number;
    unpricedCalls: number;
    ttftMs?: number | null;
    llmCallCount: number;
}

export interface DatabaseAttemptUsageWrite {
    calls: DatabaseLlmCallPartInput[];
    summary: DatabaseUsageSummary;
}

export interface DatabaseTurnBehaviorSignals {
    firstTextMs?: number | null;
    toolCallCount: number;
    toolArgumentErrorCount: number;
    modelSwitchCount: number;
    hitIterationCeiling: boolean;
    errorCode?: string | null;
    retryScope?: string | null;
}

export type DatabaseOperation =
    | { kind: 'setting_find'; key: string }
    | { kind: 'setting_get'; key: string }
    | { kind: 'setting_set'; key: string; value: string }
    | { kind: 'statistic_get'; key: string }
    | { kind: 'statistic_set'; key: string; value: string }
    | { kind: 'meta_get'; key: string }
    | { kind: 'meta_set'; key: string; value: string }
    | { kind: 'meta_delete'; key: string }
    | { kind: 'quick_search_find'; queryNorm: string; limit: number }
    | {
          kind: 'quick_search_upsert';
          queryNorm: string;
          pathNorm: string;
          maxClickCount: number;
      }
    | { kind: 'session_create'; data: Record<string, unknown> }
    | { kind: 'session_find_by_id'; id: number }
    | { kind: 'session_list'; query?: string; limit?: number }
    | { kind: 'session_messages'; sessionId: number }
    | { kind: 'session_history'; sessionId: number }
    | { kind: 'session_update'; id: number; data: Record<string, unknown> }
    | { kind: 'session_dismiss_terminal_status'; id: number }
    | { kind: 'session_refresh_metadata'; id: number }
    | { kind: 'session_count' }
    | { kind: 'session_delete_all' }
    | { kind: 'message_count' }
    | { kind: 'message_delete_all' }
    | { kind: 'session_turn_count' }
    | { kind: 'session_turn_delete_all' }
    | { kind: 'tool_part_create'; toolKind: ToolPartKind; data: Record<string, unknown> }
    | {
          kind: 'tool_part_list';
          toolKind: ToolPartKind;
          filter: ToolPartFilter;
          limit?: number;
          offset?: number;
      }
    | {
          kind: 'tool_part_update';
          toolKind: ToolPartKind;
          filter: ToolPartFilter;
          data: Record<string, unknown>;
      }
    | { kind: 'provider_list' }
    | { kind: 'provider_find'; id: number }
    | { kind: 'provider_create'; data: Record<string, unknown> }
    | { kind: 'provider_update'; id: number; data: Record<string, unknown> }
    | { kind: 'provider_delete'; id: number }
    | { kind: 'model_list_with_provider'; providerId?: number }
    | { kind: 'model_find_default_with_provider' }
    | { kind: 'model_find_by_provider_and_model_id'; providerId: number; modelId: string }
    | { kind: 'model_find_default' }
    | { kind: 'model_create'; data: Record<string, unknown> }
    | { kind: 'model_update'; id: number; data: Record<string, unknown> }
    | { kind: 'model_delete'; id: number }
    | { kind: 'model_set_default'; modelId: number }
    | {
          kind: 'model_record_upstream_metadata';
          providerId: number;
          entries: Array<{ model_id: string; metadata: Record<string, unknown> }>;
      }
    | {
          kind: 'model_persist_catalog';
          providerId: number;
          models: Array<{ model_id: string; name: string }>;
          entries: Array<{ model_id: string; metadata: Record<string, unknown> }>;
      }
    | { kind: 'model_sync_metadata' }
    | { kind: 'llm_metadata_find'; modelId: string }
    | { kind: 'llm_metadata_insert'; data: Array<Record<string, unknown>> }
    | { kind: 'llm_metadata_clear' }
    | { kind: 'llm_metadata_is_empty' }
    | { kind: 'llm_metadata_alias_is_empty' }
    | { kind: 'llm_metadata_find_pricing'; modelId: string }
    | { kind: 'llm_metadata_count_priced' }
    | {
          kind: 'llm_metadata_replace';
          metadata: Array<Record<string, unknown>>;
          aliases: Array<Record<string, unknown>>;
          markUpdatedAt: boolean;
          sourceEtag?: string | null;
      }
    | { kind: 'llm_metadata_mark_checked'; checkedAt: string; etag?: string | null }
    | { kind: 'mcp_server_list'; enabledOnly: boolean }
    | { kind: 'mcp_server_find_by_id'; id: number }
    | { kind: 'mcp_server_find_by_name'; name: string }
    | { kind: 'mcp_server_create'; data: Record<string, unknown> }
    | { kind: 'mcp_server_update'; id: number; data: Record<string, unknown> }
    | { kind: 'mcp_server_delete'; id: number }
    | { kind: 'mcp_server_count' }
    | { kind: 'mcp_tool_list'; serverId?: number; enabledOnly: boolean }
    | { kind: 'mcp_tool_find_by_id'; id: number }
    | { kind: 'mcp_tool_find_by_server_and_name'; serverId: number; name: string }
    | { kind: 'mcp_tool_create'; data: Record<string, unknown> }
    | { kind: 'mcp_tool_update'; id: number; data: Record<string, unknown> }
    | { kind: 'mcp_tool_delete'; id: number }
    | { kind: 'mcp_tool_delete_by_server'; serverId: number }
    | { kind: 'mcp_tool_count'; serverId?: number }
    | {
          kind: 'mcp_tool_sync';
          serverId: number;
          tools: Array<{
              name: string;
              description?: string | null;
              inputSchema: unknown;
          }>;
      }
    | { kind: 'built_in_tool_list'; enabledOnly: boolean }
    | { kind: 'built_in_tool_find_by_id'; id: number }
    | { kind: 'built_in_tool_find_by_tool_id'; toolId: string }
    | { kind: 'built_in_tool_create'; data: Record<string, unknown> }
    | { kind: 'built_in_tool_update'; id: number; data: Record<string, unknown> }
    | { kind: 'built_in_tool_update_many'; ids: number[]; data: Record<string, unknown> }
    | { kind: 'built_in_tool_touch'; toolId: string; lastUsedAt: string }
    | { kind: 'built_in_tool_count_enabled' }
    | { kind: 'attachment_ensure'; input: DatabaseAttachmentInput }
    | {
          kind: 'attachment_remote_ref_find';
          attachmentId: number;
          providerId: number;
          transportKind: string;
      }
    | {
          kind: 'attachment_remote_ref_upsert';
          data: {
              attachment_id: number;
              provider_id: number;
              transport_kind: string;
              remote_ref: string;
              mime_type?: string | null;
              expires_at?: string | null;
              last_used_at?: string | null;
              created_at?: string | null;
              updated_at?: string | null;
          };
      }
    | {
          kind: 'attachment_remote_ref_touch';
          id: number;
          lastUsedAt?: string | null;
      }
    | {
          kind: 'task_record_start';
          input: {
              sessionId?: number | null;
              sessionTitle: string;
              modelId: number;
              modelName: string;
              providerId: number;
              taskId: string;
              executionMode: 'foreground' | 'background';
              prompt: string;
              promptSnapshotJson: string;
              promptBreakdownJson?: string | null;
              checkpointJson: string;
              deliveryManifestJson: string;
              startedAt: string;
              maxRetries: number;
              existingUserMessageId?: number | null;
              existingTurnId?: number | null;
              existingAttemptId?: number | null;
              attachments: DatabaseAttachmentInput[];
          };
      }
    | {
          kind: 'task_persist_output_message';
          input: {
              sessionId: number;
              turnId?: number | null;
              messageId?: number | null;
              role: 'assistant' | 'tool_call';
              linkTurn: boolean;
              parts: DatabaseOutputPartInput[];
          };
      }
    | {
          kind: 'task_persist_tool_result';
          input: {
              toolCallPartId?: number | null;
              toolCallId?: string | null;
              toolCallMessageId?: number | null;
              result: string;
              attachments: DatabaseAttachmentInput[];
          };
      }
    | {
          kind: 'task_update_attempt';
          input: {
              attemptId: number;
              checkpointJson?: string | null;
              deliveryManifestJson?: string | null;
          };
      }
    | {
          kind: 'task_finish';
          input: {
              sessionId: number;
              turnId?: number | null;
              attemptId?: number | null;
              assistantMessageId?: number | null;
              pendingMessageId?: number | null;
              status: 'completed' | 'failed' | 'cancelled';
              errorMessage?: string | null;
              durationMs?: number | null;
              tokensUsed?: number | null;
              finishedAt: string;
              parts?: DatabaseOutputPartInput[] | null;
              usage?: DatabaseAttemptUsageWrite | null;
              behavior: DatabaseTurnBehaviorSignals;
              turnBootstrap?: {
                  modelId: number;
                  taskId: string;
                  executionMode: 'foreground' | 'background';
                  promptSnapshotJson: string;
                  promptMessageId?: number | null;
              } | null;
          };
      }
    | {
          kind: 'task_begin_next_attempt';
          input: {
              turnId: number;
              currentAttemptId: number;
              currentAttemptIndex: number;
              errorMessage: string;
              durationMs?: number | null;
              finishedAt: string;
              attemptIndex: number;
              maxRetries: number;
              checkpointJson: string;
              deliveryManifestJson: string;
              startedAt: string;
              usage?: DatabaseAttemptUsageWrite | null;
              behavior: DatabaseTurnBehaviorSignals;
          };
      };

export interface DatabaseOperationError {
    code: string;
    message: string;
}

export type DatabaseQueryMethod = 'run' | 'all' | 'get' | 'values';
export type DatabaseTransactionBehavior = 'deferred' | 'immediate' | 'exclusive';
export type DatabaseImportMode = 'chat_only' | 'full';

export interface DatabaseQueryRequest {
    sql: string;
    params?: SqlValue[];
    method: DatabaseQueryMethod;
}

export interface DatabaseQueryResponse {
    rows: Array<Record<string, unknown>>;
    rowsAffected: number;
    lastInsertId: number | null;
}

export interface DatabaseImportRequest {
    sourcePath: string;
    mode: DatabaseImportMode;
}

export const database = {
    operation<T>(request: DatabaseOperation): Promise<T> {
        return invoke<T>('database_operation', { request }).catch((error: unknown) => {
            const normalized = normalizeDatabaseOperationError(error);
            throw normalized;
        });
    },

    query(request: DatabaseQueryRequest): Promise<DatabaseQueryResponse> {
        return invoke('database_query', { request });
    },

    batch(requests: DatabaseQueryRequest[]): Promise<DatabaseQueryResponse[]> {
        return invoke('database_batch', { requests });
    },

    txBegin(behavior?: DatabaseTransactionBehavior): Promise<string> {
        return invoke('database_tx_begin', { behavior });
    },

    txQuery(txId: string, request: DatabaseQueryRequest): Promise<DatabaseQueryResponse> {
        return invoke('database_tx_query', { txId, request });
    },

    txBatch(txId: string, requests: DatabaseQueryRequest[]): Promise<DatabaseQueryResponse[]> {
        return invoke('database_tx_batch', { txId, requests });
    },

    txCommit(txId: string): Promise<void> {
        return invoke('database_tx_commit', { txId });
    },

    txRollback(txId: string): Promise<void> {
        return invoke('database_tx_rollback', { txId });
    },

    exportBackup(targetPath: string): Promise<void> {
        return invoke('database_export_backup', { targetPath });
    },

    importBackup(request: DatabaseImportRequest): Promise<void> {
        return invoke('database_import_backup', { request });
    },
} as const;

function normalizeDatabaseOperationError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    if (error && typeof error === 'object') {
        const value = error as Partial<DatabaseOperationError>;
        if (typeof value.message === 'string') {
            const normalized = new Error(value.message);
            if (typeof value.code === 'string') {
                (normalized as Error & { code?: string }).code = value.code;
            }
            return normalized;
        }
    }
    return new Error(String(error));
}
