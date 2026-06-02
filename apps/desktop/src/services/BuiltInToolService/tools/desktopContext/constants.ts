// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

export const DESKTOP_CONTEXT_TOOL_NAME = 'GetDesktopContext';

export const DESKTOP_CONTEXT_TOOL_DESCRIPTION = [
    'Read the immutable desktop context capsule bound to the current user turn.',
    'This is read-only context, not computer use: the tool cannot click, type, focus, scroll, or control apps.',
    'Use include as an extensible array. Sensitive fields such as clipboard full text and screenshot image path are returned only when explicitly requested.',
].join(' ');

export const DESKTOP_CONTEXT_INCLUDE_VALUES = [
    'summary',
    'active_window',
    'selected_text.summary',
    'selected_text.full_text',
    'clipboard.summary',
    'clipboard.full_text',
    'screenshot.metadata',
    'screenshot.image',
    'capabilities',
    'redactions',
] as const;

export const DESKTOP_CONTEXT_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        scope: {
            type: 'string',
            enum: ['current', 'previous', 'recent', 'diff'],
            description:
                'Desktop context scope. Phase 1 supports the current bound turn capsule; other scopes return current-compatible metadata until recent capsule history is enabled.',
        },
        limit: {
            type: 'number',
            description: 'Maximum number of capsules to return for recent scope. Reserved for later.',
        },
        include: {
            type: 'array',
            items: {
                type: 'string',
                enum: [...DESKTOP_CONTEXT_INCLUDE_VALUES],
            },
            description:
                'Fields to include. Defaults to summary, active_window, selected_text.full_text, clipboard.summary, capabilities, and redactions.',
        },
        screenshotTarget: {
            type: 'string',
            enum: ['capsule_default', 'active_window', 'active_display', 'all_displays'],
            description:
                'Requested screenshot target. Phase 1 returns the capsule default screenshot metadata or path.',
        },
    },
    additionalProperties: false,
};
