// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import {
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    z,
} from '../../utils/toolSchema';

export const APP_SESSION_TOOL_ID = 'app_session';
export const APP_OBSERVE_TOOL_ID = 'app_observe';
export const APP_ACT_TOOL_ID = 'app_act';

export const APP_USE_ADAPTER_IDS = [
    'office_word',
    'office_excel',
    'office_powerpoint',
    'wps_writer',
    'wps_spreadsheet',
    'wps_presentation',
    'photoshop',
    'illustrator',
] as const;

export type AppUseAdapterId = (typeof APP_USE_ADAPTER_IDS)[number];

export const APP_USE_SESSION_OPERATIONS = ['status', 'discover', 'capabilities'] as const;
export const APP_USE_OBSERVE_SCOPES = [
    'active_document',
    'selection',
    'workbook',
    'worksheet',
    'presentation',
    'slide',
    'layers',
    'artboards',
] as const;

export const APP_USE_ACT_ACTIONS = [
    'insert_text',
    'replace_selection',
    'read_cells',
    'write_cells',
    'add_slide_text',
    'select_layer',
    'export_preview',
    'batch_export',
    'format_selection',
    'cross_app_transfer',
] as const;

export const appUseAdapterIdSchema = z.enum(APP_USE_ADAPTER_IDS);

export const appUseSessionArgsSchema = z
    .object({
        operation: z.enum(APP_USE_SESSION_OPERATIONS).default('discover'),
        description: nonEmptyTrimmedStringSchema,
    })
    .strict();

export const appUseObserveArgsSchema = z
    .object({
        adapterId: appUseAdapterIdSchema,
        scope: z.enum(APP_USE_OBSERVE_SCOPES).default('active_document'),
        description: nonEmptyTrimmedStringSchema,
        targetId: z.string().trim().optional(),
        maxOutputChars: optionalIntegerInRangeSchema(1000, 50000),
    })
    .strict();

export const appUseActArgsSchema = z
    .object({
        adapterId: appUseAdapterIdSchema,
        action: z.enum(APP_USE_ACT_ACTIONS),
        description: nonEmptyTrimmedStringSchema,
        targetId: z.string().trim().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();

export const APP_SESSION_TOOL_DESCRIPTION = [
    'Discover and inspect supported local desktop applications for App Use.',
    'Use this before observing or acting on Office, WPS, Photoshop, or Illustrator.',
    'This tool only reports structured status and capabilities; it does not execute raw scripts.',
].join(' ');

export const APP_OBSERVE_TOOL_DESCRIPTION = [
    'Read structured App Use context from an enabled local application adapter.',
    'Supported scopes include active documents, selections, workbooks, worksheets, presentations, slides, layers, and artboards.',
    'Do not request broad background reads unless the user explicitly asks.',
].join(' ');

export const APP_ACT_TOOL_DESCRIPTION = [
    'Execute exactly one bounded App Use action in an enabled local application adapter.',
    'Mutating actions require user approval and raw script, macro, VBA, COM, UXP, or batchPlay payloads are not accepted.',
].join(' ');

export const APP_SESSION_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        operation: {
            type: 'string',
            enum: [...APP_USE_SESSION_OPERATIONS],
            description: 'Session operation to run.',
            default: 'discover',
        },
        description: {
            type: 'string',
            description: 'User-facing reason for discovering or inspecting local app capabilities.',
        },
    },
    required: ['description'],
    additionalProperties: false,
};

export const APP_OBSERVE_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        adapterId: {
            type: 'string',
            enum: [...APP_USE_ADAPTER_IDS],
            description: 'Enabled App Use adapter to observe.',
        },
        scope: {
            type: 'string',
            enum: [...APP_USE_OBSERVE_SCOPES],
            description: 'Structured observation scope.',
            default: 'active_document',
        },
        description: {
            type: 'string',
            description: 'User-facing reason for reading this app context.',
        },
        targetId: {
            type: 'string',
            description: 'Optional target id returned by app_session or a prior app_observe call.',
        },
        maxOutputChars: {
            type: 'number',
            description: 'Optional output limit for text-heavy observations.',
        },
    },
    required: ['adapterId', 'description'],
    additionalProperties: false,
};

export const APP_ACT_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        adapterId: {
            type: 'string',
            enum: [...APP_USE_ADAPTER_IDS],
            description: 'Enabled App Use adapter that should execute the action.',
        },
        action: {
            type: 'string',
            enum: [...APP_USE_ACT_ACTIONS],
            description: 'Single bounded action to execute.',
        },
        description: {
            type: 'string',
            description: 'User-facing reason shown in the approval UI.',
        },
        targetId: {
            type: 'string',
            description: 'Optional target id returned by app_session or app_observe.',
        },
        parameters: {
            type: 'object',
            description:
                'Structured parameters for the bounded action. Raw scripts are not allowed.',
        },
    },
    required: ['adapterId', 'action', 'description'],
    additionalProperties: false,
};
