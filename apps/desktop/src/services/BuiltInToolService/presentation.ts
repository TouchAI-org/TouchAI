// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { builtInToolRegistry } from './registry';
import type {
    BuiltInToolConversationPresentation,
    BuiltInToolConversationSemantic,
    BuiltInToolConversationSemanticAction,
    BuiltInToolConversationStatus,
    BuiltInToolId,
} from './types';

const BUILTIN_TOOL_PREFIX = 'builtin__';

function normalizeToolId(toolName: string): BuiltInToolId | null {
    const trimmed = toolName.trim();
    if (!trimmed) {
        return null;
    }

    const directId = trimmed.startsWith(BUILTIN_TOOL_PREFIX)
        ? trimmed.slice(BUILTIN_TOOL_PREFIX.length)
        : trimmed;
    const directMatch = builtInToolRegistry.get(directId);
    if (directMatch) {
        return directMatch.id;
    }

    const normalized = trimmed.toLowerCase().replace(/[\s_-]+/g, '');
    for (const tool of builtInToolRegistry.list()) {
        const toolId = tool.id.toLowerCase().replace(/[\s_-]+/g, '');
        const displayName = tool.displayName.toLowerCase().replace(/[\s_-]+/g, '');
        if (normalized === toolId || normalized === displayName) {
            return tool.id;
        }
    }

    return null;
}

function getBuiltInToolConversationVerb(
    action: BuiltInToolConversationSemanticAction,
    status: BuiltInToolConversationStatus
): string {
    if (status === 'awaiting_approval') {
        return '等待批准';
    }

    if (status === 'rejected') {
        return '已拒绝';
    }

    if (status === 'cancelled') {
        return '已取消';
    }

    switch (action) {
        case 'run':
            return status === 'executing' ? '已启动' : status === 'error' ? '运行失败' : '已运行';
        case 'search':
            return status === 'executing' ? '正在搜索' : status === 'error' ? '搜索失败' : '已搜索';
        case 'read':
            return status === 'executing' ? '正在读取' : status === 'error' ? '读取失败' : '已读取';
        case 'review':
            return status === 'executing' ? '正在阅读' : status === 'error' ? '读取失败' : '已阅读';
        case 'update':
            return status === 'executing' ? '正在更新' : status === 'error' ? '更新失败' : '已更新';
        case 'switch':
            return status === 'executing' ? '正在切换' : status === 'error' ? '切换失败' : '已切换';
        case 'render':
            return status === 'executing' ? '正在渲染' : status === 'error' ? '渲染失败' : '已渲染';
        case 'remove':
            return status === 'executing' ? '正在移除' : status === 'error' ? '移除失败' : '已移除';
        default:
            return status === 'executing' ? '正在处理' : status === 'error' ? '处理失败' : '已处理';
    }
}

interface ResolveBuiltInToolConversationSemanticOptions {
    semantic?: BuiltInToolConversationSemantic;
    result?: string;
}

function buildBuiltInToolConversationPresentationFromSemantic(
    semantic: BuiltInToolConversationSemantic,
    status: BuiltInToolConversationStatus,
    fallbackContent: string
): BuiltInToolConversationPresentation {
    return {
        verb: getBuiltInToolConversationVerb(semantic.action, status),
        content: semantic.target?.trim() || fallbackContent,
    };
}

export function resolveBuiltInToolConversationSemantic(
    toolName: string,
    args: Record<string, unknown>,
    options: ResolveBuiltInToolConversationSemanticOptions = {}
): BuiltInToolConversationSemantic | null {
    const toolId = normalizeToolId(toolName);
    if (!toolId) {
        return null;
    }

    const tool = builtInToolRegistry.get(toolId);
    if (!tool) {
        return null;
    }

    if (options.semantic) {
        return options.semantic;
    }

    const semanticFromResult =
        typeof options.result === 'string'
            ? tool.buildConversationSemanticFromResult(options.result, args)
            : null;
    if (semanticFromResult) {
        return semanticFromResult;
    }

    return tool.buildConversationSemantic(args);
}

export function buildBuiltInToolConversationPresentation(
    toolName: string,
    args: Record<string, unknown>,
    status: BuiltInToolConversationStatus,
    options: ResolveBuiltInToolConversationSemanticOptions = {}
): BuiltInToolConversationPresentation | null {
    const toolId = normalizeToolId(toolName);
    if (!toolId) {
        return null;
    }

    const tool = builtInToolRegistry.get(toolId);
    if (!tool) {
        return null;
    }

    const semantic = resolveBuiltInToolConversationSemantic(toolName, args, options);
    if (!semantic) {
        return null;
    }

    return buildBuiltInToolConversationPresentationFromSemantic(semantic, status, tool.displayName);
}
