// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 任务层公共契约。
 *
 * 这里是「页面 / 调用方可以观察到的任务」的稳定语言：任务状态、执行模式、
 * 模型展示摘要、任务生命周期事件与完成结果。它们**只携带展示数据**，
 * 不含 executor checkpoint、prompt 内部结构或 provider 凭据。
 *
 * 放在 `contracts` 是为了让 `task`、`execution`、`outputs` 都依赖同一份
 * 中性契约，而不是让 `task` 反向依赖 `execution` 的 barrel。
 */

import type { ModelWithProvider } from '@database/queries/models';
import type { DbTurnStatus, SessionTurnEntity } from '@database/types';

/** 任务执行模式：前台有视图观察，后台允许脱离页面继续运行。 */
export type TaskExecutionMode = 'foreground' | 'background';

/** 任务对外可见的生命周期状态。 */
export type SessionTaskStatus =
    | 'running'
    | 'waiting_approval'
    | 'completed'
    | 'failed'
    | 'cancelled';

/**
 * 任务关联模型的展示摘要。
 *
 * 由数据库模型行裁剪而来：不含 `api_key` / `provider_config_json` 等凭据。
 */
export interface TaskModelSummary {
    modelDbId: number | null;
    providerId: number;
    providerName: string;
    modelId: string;
    modelName: string;
}

/** 把数据库模型行裁剪为无凭据的展示摘要。 */
export function summarizeTaskModel(model: ModelWithProvider): TaskModelSummary {
    return {
        modelDbId: model.id,
        providerId: model.provider_id,
        providerName: model.provider_name,
        modelId: model.model_id,
        modelName: model.name,
    };
}

/**
 * 公共任务生命周期事件。
 *
 * 只包含展示数据：没有 checkpoint、prompt 内部结构或 provider 凭据。
 * 运行时的内部事件（checkpoint_committed / retry_scheduled）不属于这个联合。
 */
export type TaskEvent =
    | {
          type: 'task_started';
          taskId: string;
          sessionId: number | null;
          turnId: number | null;
          executionMode: TaskExecutionMode;
          model: TaskModelSummary;
      }
    | {
          type: 'task_completed';
          taskId: string;
          turnId: number | null;
          model: TaskModelSummary;
          response: string;
          reasoning: string;
      }
    | {
          type: 'task_failed';
          taskId: string;
          turnId: number | null;
          error: string;
      }
    | {
          type: 'task_cancelled';
          taskId: string;
          turnId: number | null;
      };

/**
 * 任务关联轮次的展示摘要。
 *
 * 数据库轮次行携带 `prompt_snapshot_json`（完整 systemPrompt / fragments /
 * inputSnapshot）等内部结构，公共契约只保留调用方需要的定位与状态字段。
 */
export interface TaskTurnSummary {
    id: number;
    sessionId: number | null;
    status: DbTurnStatus;
}

/** 把数据库轮次行裁剪为无 prompt 内部结构的展示摘要。 */
export function summarizeTaskTurn(turn: SessionTurnEntity | null): TaskTurnSummary | null {
    if (!turn) {
        return null;
    }
    return {
        id: turn.id,
        sessionId: turn.session_id,
        status: turn.status,
    };
}

/**
 * 任务完成的公共结果。`model` / `turn` 都是展示摘要，不是带凭据或 prompt
 * 内部结构的数据库行。
 */
export interface TaskResult {
    model: TaskModelSummary;
    response: string;
    reasoning: string;
    turn: TaskTurnSummary | null;
}

/**
 * 把可能含内部字段的事件投影成公共事件。
 *
 * 逐字段白名单复制（含嵌套的模型摘要），因此即使输入带 `checkpoint`、
 * `attemptToken`、`api_key` 等额外字段也不会外泄；内部事件返回 `null`。
 */
export function toPublicTaskEvent(
    event: { type: string } & Record<string, unknown>
): TaskEvent | null {
    const summarize = (value: unknown): TaskModelSummary | null => {
        if (!value || typeof value !== 'object') {
            return null;
        }
        const model = value as Record<string, unknown>;
        return {
            modelDbId: typeof model.modelDbId === 'number' ? model.modelDbId : null,
            providerId: typeof model.providerId === 'number' ? model.providerId : 0,
            providerName: typeof model.providerName === 'string' ? model.providerName : '',
            modelId: typeof model.modelId === 'string' ? model.modelId : '',
            modelName: typeof model.modelName === 'string' ? model.modelName : '',
        };
    };

    switch (event.type) {
        case 'task_started': {
            const model = summarize(event.model);
            if (!model) {
                return null;
            }
            return {
                type: 'task_started',
                taskId: String(event.taskId ?? ''),
                sessionId: typeof event.sessionId === 'number' ? event.sessionId : null,
                turnId: typeof event.turnId === 'number' ? event.turnId : null,
                executionMode: event.executionMode === 'background' ? 'background' : 'foreground',
                model,
            };
        }
        case 'task_completed': {
            const model = summarize(event.model);
            if (!model) {
                return null;
            }
            return {
                type: 'task_completed',
                taskId: String(event.taskId ?? ''),
                turnId: typeof event.turnId === 'number' ? event.turnId : null,
                model,
                response: typeof event.response === 'string' ? event.response : '',
                reasoning: typeof event.reasoning === 'string' ? event.reasoning : '',
            };
        }
        case 'task_failed':
            return {
                type: 'task_failed',
                taskId: String(event.taskId ?? ''),
                turnId: typeof event.turnId === 'number' ? event.turnId : null,
                error: typeof event.error === 'string' ? event.error : '',
            };
        case 'task_cancelled':
            return {
                type: 'task_cancelled',
                taskId: String(event.taskId ?? ''),
                turnId: typeof event.turnId === 'number' ? event.turnId : null,
            };
        default:
            return null;
    }
}
