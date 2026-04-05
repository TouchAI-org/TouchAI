// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 任务投影器。
 *
 * 将底层执行事件投影为 UI 可直接消费的任务快照。
 *
 * 内部按关注点拆分为四个模块：
 * - `helpers`   — 共享纯工具函数
 * - `toolCalls` — 工具调用状态投影
 * - `widgets`   — Widget 生命周期投影
 * - `approvals` — 审批队列投影
 * - `projection` — 协调层（主投影器类）
 */
export { SessionTaskProjection } from './projection';
