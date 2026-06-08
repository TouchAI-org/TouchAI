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

export const APP_USE_ACT_ADAPTER_IDS = [
    'office_word',
    'office_excel',
    'office_powerpoint',
    'wps_writer',
    'wps_spreadsheet',
    'wps_presentation',
] as const;

type AppUseActAdapterId = (typeof APP_USE_ACT_ADAPTER_IDS)[number];

export const APP_USE_SESSION_OPERATIONS = [
    'status',
    'discover',
    'capabilities',
    'create_owned_target',
] as const;
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
    'replace_document_text',
    'write_cells',
    'add_slide_text',
    'format_document_text',
] as const;

type AppUseActAction = (typeof APP_USE_ACT_ACTIONS)[number];
type AppUseActArgs = {
    adapterId: AppUseActAdapterId;
    action: AppUseActAction;
    description: string;
    targetId: string;
    parameters: Record<string, unknown>;
};

export const appUseAdapterIdSchema = z.enum(APP_USE_ADAPTER_IDS);
const appUseActAdapterIdSchema = z.enum(APP_USE_ACT_ADAPTER_IDS);

const APP_USE_ACT_ACTIONS_BY_ADAPTER = {
    office_word: ['replace_document_text', 'format_document_text'],
    office_excel: ['write_cells'],
    office_powerpoint: ['add_slide_text'],
    wps_writer: ['replace_document_text', 'format_document_text'],
    wps_spreadsheet: ['write_cells'],
    wps_presentation: ['add_slide_text'],
} as const satisfies Record<AppUseActAdapterId, readonly AppUseActAction[]>;

export const appUseSessionArgsSchema = z
    .object({
        operation: z.enum(APP_USE_SESSION_OPERATIONS).default('discover'),
        description: nonEmptyTrimmedStringSchema,
        adapterId: appUseActAdapterIdSchema.optional(),
        targetKind: z.enum(['document', 'spreadsheet', 'presentation']).optional(),
    })
    .strict()
    .superRefine((value, context) => {
        if (value.operation !== 'create_owned_target') {
            return;
        }
        if (!value.adapterId) {
            context.addIssue({
                code: 'custom',
                path: ['adapterId'],
                message: 'create_owned_target requires an Office or WPS write adapterId',
            });
        }
    });

export const appUseObserveArgsSchema = z
    .object({
        adapterId: appUseAdapterIdSchema,
        scope: z.enum(APP_USE_OBSERVE_SCOPES).default('active_document'),
        description: nonEmptyTrimmedStringSchema,
        targetId: z.string().trim().optional(),
        maxOutputChars: optionalIntegerInRangeSchema(1000, 50000),
    })
    .strict();

function boundedTrimmedStringSchema(maxLength: number) {
    return z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string().min(1).max(maxLength)
    );
}

const appUseScalarCellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const appUseTextActionParametersSchema = z
    .object({
        text: boundedTrimmedStringSchema(20000),
    })
    .strict();
const appUseFormatDocumentTextParametersSchema = z
    .object({
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        underline: z.boolean().optional(),
        fontSize: z.number().min(6).max(96).optional(),
        fontName: boundedTrimmedStringSchema(128).optional(),
    })
    .strict()
    .refine(
        (value) =>
            value.bold !== undefined ||
            value.italic !== undefined ||
            value.underline !== undefined ||
            value.fontSize !== undefined ||
            value.fontName !== undefined,
        { message: 'format_document_text requires at least one format option' }
    );
const appUseWriteCellsParametersSchema = z
    .object({
        range: boundedTrimmedStringSchema(64).refine(
            (value) => /^[A-Za-z0-9:$]+$/.test(value),
            'range must be an A1-style address'
        ),
        sheetName: boundedTrimmedStringSchema(128).optional(),
        values: z
            .array(z.array(appUseScalarCellValueSchema).min(1))
            .min(1)
            .refine((rows) => {
                const width = rows[0]?.length;
                return width !== undefined && rows.every((row) => row.length === width);
            }, 'values must use rectangular rows'),
    })
    .strict();
const appUseAddSlideTextParametersSchema = z
    .object({
        text: boundedTrimmedStringSchema(2000),
        slideIndex: z.number().int().min(1).optional(),
    })
    .strict();

const appUseParametersSchemaByAction: Record<
    AppUseActAction,
    z.ZodType<Record<string, unknown>>
> = {
    replace_document_text: appUseTextActionParametersSchema,
    format_document_text: appUseFormatDocumentTextParametersSchema,
    write_cells: appUseWriteCellsParametersSchema,
    add_slide_text: appUseAddSlideTextParametersSchema,
};

const RAW_AUTOMATION_PARAMETER_KEYS = new Set([
    'script',
    'rawscript',
    'macro',
    'vba',
    'com',
    'uxp',
    'batchplay',
    'extendscript',
    'javascript',
]);

function rejectRawAutomationParameters(
    value: unknown,
    context: z.RefinementCtx,
    path: Array<string | number>
) {
    if (Array.isArray(value)) {
        value.forEach((item, index) =>
            rejectRawAutomationParameters(item, context, [...path, index])
        );
        return;
    }

    if (!value || typeof value !== 'object') {
        return;
    }

    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        const nextPath = [...path, key];
        if (RAW_AUTOMATION_PARAMETER_KEYS.has(key.toLowerCase())) {
            context.addIssue({
                code: 'custom',
                path: nextPath,
                message: 'Raw automation payloads are not allowed in App Use parameters',
            });
        }
        rejectRawAutomationParameters(nestedValue, context, nextPath);
    }
}

export const appUseActArgsSchema = z
    .object({
        adapterId: appUseActAdapterIdSchema,
        action: z.enum(APP_USE_ACT_ACTIONS),
        description: nonEmptyTrimmedStringSchema,
        targetId: nonEmptyTrimmedStringSchema,
        parameters: z.record(z.string(), z.unknown()),
    })
    .strict()
    .superRefine((value, context) => {
        rejectRawAutomationParameters(value.parameters, context, ['parameters']);
        const supportedActions = APP_USE_ACT_ACTIONS_BY_ADAPTER[
            value.adapterId
        ] as readonly AppUseActAction[];
        if (!supportedActions.includes(value.action)) {
            context.addIssue({
                code: 'custom',
                path: ['action'],
                message: `${value.adapterId} does not support ${value.action}`,
            });
        }

        const parameters = appUseParametersSchemaByAction[value.action].safeParse(value.parameters);
        if (!parameters.success) {
            for (const issue of parameters.error.issues) {
                context.addIssue({
                    ...issue,
                    path: ['parameters', ...issue.path],
                });
            }
        }
    })
    .transform((value): AppUseActArgs => {
        return {
            ...value,
            parameters: appUseParametersSchemaByAction[value.action].parse(value.parameters),
        };
    });

export const APP_SESSION_TOOL_DESCRIPTION = [
    'Discover and inspect supported local desktop applications for App Use.',
    'Use create_owned_target before Office or WPS write actions to create a TouchAI-owned signed target path.',
    'This tool only reports structured status and capabilities; it does not execute raw scripts.',
].join(' ');

export const APP_OBSERVE_TOOL_DESCRIPTION = [
    'Read structured App Use context from an enabled local application adapter.',
    'Supported scopes include active documents, selections, workbooks, worksheets, presentations, slides, layers, and artboards.',
    'Only request the active, bounded observation scope needed for the user task.',
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
            description:
                'Session operation to run. Use create_owned_target to create a TouchAI-owned signed target path for Office or WPS write actions.',
            default: 'discover',
        },
        description: {
            type: 'string',
            description: 'User-facing reason for discovering or inspecting local app capabilities.',
        },
        adapterId: {
            type: 'string',
            enum: [...APP_USE_ACT_ADAPTER_IDS],
            description:
                'Required for create_owned_target. Office or WPS write adapter that will use the created target.',
        },
        targetKind: {
            type: 'string',
            enum: ['document', 'spreadsheet', 'presentation'],
            description:
                'Optional create_owned_target target kind. It must match the selected adapter family.',
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
            description:
                'Optional TouchAI-owned signed target path returned by a trusted App Use target creation or owned-target observation flow. Do not invent or reuse arbitrary local paths.',
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
            enum: [...APP_USE_ACT_ADAPTER_IDS],
            description:
                'Enabled App Use adapter that should execute the action. Adobe adapters are observe-only in this phase.',
        },
        action: {
            type: 'string',
            enum: [...APP_USE_ACT_ACTIONS],
            description:
                'Single bounded action to execute. Use app_observe for read-only cells, layers, artboards, documents, and slides.',
        },
        description: {
            type: 'string',
            description: 'User-facing reason shown in the approval UI.',
        },
        targetId: {
            type: 'string',
            description:
                'Required for Office and WPS write actions. Must be a TouchAI-owned signed target path, not an arbitrary local path or a raw app_session/app_observe value.',
        },
        parameters: {
            type: 'object',
            description:
                'Structured parameters for the bounded action. Use {text} for replace_document_text and add_slide_text; use {range, values, sheetName?} for write_cells; use {bold?, italic?, underline?, fontSize?, fontName?} for format_document_text. Raw scripts are not allowed.',
        },
    },
    required: ['adapterId', 'action', 'description', 'targetId', 'parameters'],
    additionalProperties: false,
};
