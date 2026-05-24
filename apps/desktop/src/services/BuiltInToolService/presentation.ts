// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { t, type MessageKey } from '@/i18n';

import { builtInToolRegistry } from './registry';
import type {
    BuiltInToolConversationPresentation,
    BuiltInToolConversationSemantic,
    BuiltInToolConversationSemanticAction,
    BuiltInToolConversationStatus,
    BuiltInToolId,
} from './types';

const BUILTIN_TOOL_PREFIX = 'builtin__';
const BUILTIN_TOOL_VERB_KEYS: Record<
    BuiltInToolConversationSemanticAction,
    Record<'executing' | 'error' | 'completed', MessageKey>
> = {
    process: {
        executing: 'builtInTools.presentation.process.executing',
        error: 'builtInTools.presentation.process.error',
        completed: 'builtInTools.presentation.process.completed',
    },
    run: {
        executing: 'builtInTools.presentation.run.executing',
        error: 'builtInTools.presentation.run.error',
        completed: 'builtInTools.presentation.run.completed',
    },
    search: {
        executing: 'builtInTools.presentation.search.executing',
        error: 'builtInTools.presentation.search.error',
        completed: 'builtInTools.presentation.search.completed',
    },
    read: {
        executing: 'builtInTools.presentation.read.executing',
        error: 'builtInTools.presentation.read.error',
        completed: 'builtInTools.presentation.read.completed',
    },
    review: {
        executing: 'builtInTools.presentation.review.executing',
        error: 'builtInTools.presentation.review.error',
        completed: 'builtInTools.presentation.review.completed',
    },
    update: {
        executing: 'builtInTools.presentation.update.executing',
        error: 'builtInTools.presentation.update.error',
        completed: 'builtInTools.presentation.update.completed',
    },
    switch: {
        executing: 'builtInTools.presentation.switch.executing',
        error: 'builtInTools.presentation.switch.error',
        completed: 'builtInTools.presentation.switch.completed',
    },
    render: {
        executing: 'builtInTools.presentation.render.executing',
        error: 'builtInTools.presentation.render.error',
        completed: 'builtInTools.presentation.render.completed',
    },
    remove: {
        executing: 'builtInTools.presentation.remove.executing',
        error: 'builtInTools.presentation.remove.error',
        completed: 'builtInTools.presentation.remove.completed',
    },
};

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
        return t('builtInTools.presentation.pendingApproval');
    }

    if (status === 'rejected') {
        return t('common.rejected');
    }

    if (status === 'cancelled') {
        return t('common.cancelled');
    }

    const key =
        BUILTIN_TOOL_VERB_KEYS[action][status === 'executing' || status === 'error'
            ? status
            : 'completed'];
    return t(key);
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
