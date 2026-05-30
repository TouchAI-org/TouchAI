// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import {
    nonEmptyTrimmedStringSchema,
    optionalTrimmedStringSchema,
    z,
} from '../../utils/toolSchema';

export const APPLY_PATCH_TOOL_NAME = 'ApplyPatch';

export const applyPatchArgsSchema = z.object({
    patch: nonEmptyTrimmedStringSchema,
    workingDirectory: nonEmptyTrimmedStringSchema,
    reason: optionalTrimmedStringSchema,
    description: optionalTrimmedStringSchema,
});

export const APPLY_PATCH_TOOL_DESCRIPTION = [
    'Apply structured, reviewable file edits inside a local workspace.',
    'When the user asks to create, edit, delete, rename, or move local workspace files, use this tool by default.',
    'Use this for coding changes and other local file mutations instead of shell-driven file mutation.',
    'Use Bash, Read, and FileSearch only to inspect files or verify results unless the user explicitly requests shell-based file operations.',
    'The patch must use the supported apply_patch grammar with *** Begin Patch and *** End Patch markers.',
    'Paths must be relative to workingDirectory. Absolute paths and parent-directory traversal are rejected.',
    'Supported operations: Add File, Update File, Delete File, and Update File with Move to.',
].join(' ');

export const APPLY_PATCH_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        patch: {
            type: 'string',
            description: [
                'Patch text using this grammar:',
                '*** Begin Patch',
                '*** Add File: path',
                '+new line',
                '*** Update File: path',
                '*** Move to: new/path',
                '@@',
                ' context line',
                '-old line',
                '+new line',
                '*** Delete File: path',
                '*** End Patch',
            ].join('\n'),
        },
        workingDirectory: {
            type: 'string',
            description:
                'Required workspace root. Every patch path is resolved relative to this directory.',
        },
        reason: {
            type: 'string',
            description:
                'Required user-facing explanation for approval: explain what files will change and why.',
        },
    },
    required: ['patch', 'workingDirectory', 'reason'],
};
