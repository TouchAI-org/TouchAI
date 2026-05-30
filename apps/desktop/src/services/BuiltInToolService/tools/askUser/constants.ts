// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

export const ASK_USER_TOOL_NAME = 'ask_user_question';

export const ASK_USER_TOOL_DESCRIPTION =
    'Ask the user structured questions with predefined options. ' +
    'Use this when you need the user to make a choice between options, ' +
    'clarify requirements, or confirm preferences. ' +
    'Supports single-select, multi-select, and free-text "Other" input. ' +
    "Returns the user's selections for each question.";

export const ASK_USER_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        questions: {
            type: 'array',
            description: 'Array of questions to ask the user (1-4 questions).',
            items: {
                type: 'object',
                properties: {
                    question: {
                        type: 'string',
                        description: 'The question text to display. Should be clear and specific.',
                        minLength: 1,
                        maxLength: 200,
                    },
                    header: {
                        type: 'string',
                        description: 'Short label displayed as a chip/tag (max 12 chars).',
                        minLength: 1,
                        maxLength: 12,
                    },
                    multiSelect: {
                        type: 'boolean',
                        description:
                            'If true, the user can select multiple options. Default: false.',
                        default: false,
                    },
                    options: {
                        type: 'array',
                        description: 'Available choices (2-4 options).',
                        items: {
                            type: 'object',
                            properties: {
                                label: {
                                    type: 'string',
                                    description: 'Display text for this option (1-5 words).',
                                    minLength: 1,
                                    maxLength: 60,
                                },
                                description: {
                                    type: 'string',
                                    description: 'Optional explanation of what this option means.',
                                    maxLength: 120,
                                },
                            },
                            required: ['label'],
                        },
                        minItems: 2,
                        maxItems: 4,
                    },
                },
                required: ['question', 'header', 'options'],
            },
            minItems: 1,
            maxItems: 4,
        },
    },
    required: ['questions'],
};
