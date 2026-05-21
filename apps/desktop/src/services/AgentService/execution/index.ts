// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * `execution` 层负责单个 task 内部的一次执行流程。
 *
 * 它处理 turn / attempt、工具循环、checkpoint、模型切换与重试，
 * 但不拥有全局任务注册和会话并发控制。
 */
export type {
    AttemptCheckpoint,
    AttemptExecutionResult,
    AttemptFailureResult,
    ModelWithProvider,
    RequestExecutionCallbacks,
    RunAttemptOptions,
} from './executor';
export { AiRequestExecutor } from './executor';
export { getRetryStatusMessage } from './retry';
export type {
    ConversationRuntimeEnvironment,
    ExecuteRequestOptions,
    ExecuteRequestResult,
    RuntimePersistenceIssue,
    TaskModelSummary,
    TurnEvent,
} from './runtime';
export { summarizeTaskModel } from './runtime';
export { AiConversationRuntime } from './runtime';
