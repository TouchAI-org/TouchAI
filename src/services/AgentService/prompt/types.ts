// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';

import type { TaskExecutionMode } from '../task/types';

/**
 * Prompt 片段来源。
 *
 * 顺序不是展示信息，而是运行时的固定优先级：
 * `override > platform > policy > agent/profile > session memory > mode > feature > user append`
 */
export type PromptFragmentSource =
    | 'override'
    | 'platform'
    | 'policy'
    | 'agent_profile'
    | 'session_memory'
    | 'mode'
    | 'feature'
    | 'user_append';

/**
 * 统一的 prompt 片段模型。
 */
export interface PromptFragment {
    id: string;
    source: PromptFragmentSource;
    content: string;
}

/**
 * 附件摘要只用于 prompt 快照观察，不包含附件原始内容。
 */
export interface PromptSnapshotAttachmentSummary {
    id: string;
    name: string;
    type: AttachmentIndex['type'];
    size: number | null;
    mimeType: string | null;
    supportStatus: AttachmentIndex['supportStatus'] | null;
}

/**
 * Prompt 装配结果。
 */
export interface PromptAssembly {
    executionMode: TaskExecutionMode;
    fragments: PromptFragment[];
    userPrompt: string;
    attachments: PromptSnapshotAttachmentSummary[];
}

/**
 * 同一 turn 内被冻结的 prompt 快照。
 *
 * retry、tool iteration、checkpoint resume 都必须复用这份快照。
 */
export interface PromptSnapshot extends PromptAssembly {
    id: string;
    createdAt: string;
    systemPrompt: string;
}
