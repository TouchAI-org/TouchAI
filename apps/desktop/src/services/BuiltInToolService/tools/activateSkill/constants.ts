// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import { optionalTrimmedStringSchema, z } from '../../utils/toolSchema';

export const ACTIVATE_SKILL_TOOL_NAME = 'ActivateSkill';

export const activateSkillArgsSchema = z
    .object({
        name: optionalTrimmedStringSchema,
        path: optionalTrimmedStringSchema,
    })
    .superRefine((value, context) => {
        if (!value.name && !value.path) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['name'],
                message: 'Expected either name or path.',
            });
        }
    });

export const ACTIVATE_SKILL_TOOL_DESCRIPTION = [
    'Read instructions for an available Agent Skill, including bundled skills.',
    'Use an exact name or catalog path when the task needs the full instructions of a specialized skill.',
    'Relative paths in a skill are resolved against its SKILL.md directory. Scripts still require the ordinary Bash tool and its approval flow.',
].join(' ');

function withExamples(description: string, ...examples: string[]): string {
    return `${description} Examples: ${examples.join(' | ')}.`;
}

export const ACTIVATE_SKILL_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        name: {
            type: 'string',
            description: withExamples(
                'Optional installed skill name. Use this when the user or available context names a skill.',
                '"code-quality-review"',
                '"ui-ux-pro-max"'
            ),
        },
        path: {
            type: 'string',
            description: withExamples(
                'Optional exact SKILL.md path from the available skill catalog.',
                '"C:\\\\Users\\\\me\\\\.agents\\\\skills\\\\code-quality-review\\\\SKILL.md"'
            ),
        },
    },
};
