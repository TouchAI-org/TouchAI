// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * `task` 层负责运行时所有权。
 *
 * 这里维护任务中心、任务快照、订阅接口与会话级并发约束，
 * 是前后台运行、审批等待、任务取消等能力的统一入口。
 */
export { sessionTaskCenter } from './center';
export type {
    SessionTaskSnapshot,
    SessionTaskStatus,
    StartedSessionTask,
    StartSessionTaskOptions,
    TaskExecutionMode,
    TaskSnapshotListener,
} from './types';
