// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    type AttachmentIndex,
    inspectAttachments,
} from '@/services/AgentService/infrastructure/attachments';

import type { TaskExecutionMode } from '../task/types';
import type { PromptAssembly, PromptFragment, PromptFragmentSource, PromptSnapshot } from './types';

const TOOL_DISCIPLINE_SYSTEM_PROMPT = [
    '你可以使用本轮请求提供的工具。',
    '当用户明确要求“调用工具”或要求执行某个必须依赖工具的动作时，必须实际发起对应工具调用，不能只用文字承诺自己会去做。',
    '当用户要求升级模型、切换到更强模型、切到更高一级模型，且 `builtin__upgrade_model` 可用时，必须直接调用 `builtin__upgrade_model`，参数为 {}。',
    '不要先输出“我来帮你升级模型”这类占位文本；应先调用工具，再基于工具结果继续回复。',
].join('\n');

const BACKGROUND_MODE_PROMPT = [
    '当前任务允许在前台页面失焦、隐藏或切换会话后继续运行。',
    '除非用户主动取消，或工具审批明确被拒绝，否则应继续完成原始任务。',
].join('\n');

const PROMPT_SOURCE_ORDER: PromptFragmentSource[] = [
    'override',
    'platform',
    'policy',
    'agent_profile',
    'session_memory',
    'mode',
    'feature',
    'user_append',
];

interface ComposePromptSnapshotOptions {
    prompt: string;
    attachments?: AttachmentIndex[];
    executionMode?: TaskExecutionMode;
    override?: string[];
    platform?: string[];
    policy?: string[];
    agentProfile?: string[];
    sessionMemory?: string[];
    mode?: string[];
    feature?: string[];
    userAppend?: string[];
}

function buildFragments(source: PromptFragmentSource, contents: string[]): PromptFragment[] {
    return contents
        .map((content) => content.trim())
        .filter(Boolean)
        .map((content) => ({
            id: crypto.randomUUID(),
            source,
            content,
        }));
}

async function summarizeAttachments(
    attachments: AttachmentIndex[]
): Promise<PromptAssembly['attachments']> {
    const inspections = await inspectAttachments(attachments);

    return inspections.map((inspection) => ({
        id: inspection.attachment.id,
        alias: inspection.meta.alias,
        name: inspection.attachment.name,
        type: inspection.attachment.type,
        size: inspection.size,
        mimeType: inspection.mimeType,
        originPath: inspection.attachment.originPath,
        attachmentId: inspection.meta.attachmentId,
        hash: inspection.meta.hash,
        derivedKind: inspection.kind,
        semanticIntent: inspection.semanticIntent,
        supportStatus: inspection.supportStatus,
    }));
}

async function buildPromptAssembly(options: ComposePromptSnapshotOptions): Promise<PromptAssembly> {
    const executionMode = options.executionMode ?? 'foreground';
    const fragmentsBySource: Record<PromptFragmentSource, PromptFragment[]> = {
        override: buildFragments('override', options.override ?? []),
        platform: buildFragments('platform', options.platform ?? []),
        policy: buildFragments('policy', options.policy ?? [TOOL_DISCIPLINE_SYSTEM_PROMPT]),
        agent_profile: buildFragments('agent_profile', options.agentProfile ?? []),
        session_memory: buildFragments('session_memory', options.sessionMemory ?? []),
        mode: buildFragments(
            'mode',
            options.mode ?? (executionMode === 'background' ? [BACKGROUND_MODE_PROMPT] : [])
        ),
        feature: buildFragments('feature', options.feature ?? []),
        user_append: buildFragments('user_append', options.userAppend ?? []),
    };

    return {
        executionMode,
        fragments: PROMPT_SOURCE_ORDER.flatMap((source) => fragmentsBySource[source]),
        userPrompt: options.prompt,
        attachments: await summarizeAttachments(options.attachments ?? []),
    };
}

/**
 * 统一装配并冻结当前 turn 的 prompt 快照。
 */
export async function composePromptSnapshot(
    options: ComposePromptSnapshotOptions
): Promise<PromptSnapshot> {
    const assembly = await buildPromptAssembly(options);

    return {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        executionMode: assembly.executionMode,
        fragments: assembly.fragments,
        userPrompt: assembly.userPrompt,
        attachments: assembly.attachments,
        systemPrompt: assembly.fragments
            .map((fragment) => fragment.content)
            .join('\n\n')
            .trim(),
    };
}
