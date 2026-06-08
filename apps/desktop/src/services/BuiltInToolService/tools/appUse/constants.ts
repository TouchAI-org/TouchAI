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

type AppUseActAction = (typeof APP_USE_ACT_ACTIONS)[number];
type AppUseActArgs = {
    adapterId: AppUseAdapterId;
    action: AppUseActAction;
    description: string;
    targetId?: string;
    parameters?: Record<string, unknown>;
};

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

function boundedTrimmedStringSchema(maxLength: number) {
    return z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string().min(1).max(maxLength)
    );
}

const appUseScalarCellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const appUseTextActionParametersSchema = z
    .object({
        text: nonEmptyTrimmedStringSchema,
    })
    .strict();
const appUseFormatSelectionParametersSchema = z
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
        { message: 'format_selection requires at least one format option' }
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
const appUseReadCellsParametersSchema = z
    .object({
        range: boundedTrimmedStringSchema(64).refine(
            (value) => /^[A-Za-z0-9:$]+$/.test(value),
            'range must be an A1-style address'
        ),
        sheetName: boundedTrimmedStringSchema(128).optional(),
    })
    .strict();
const appUseAddSlideTextParametersSchema = z
    .object({
        text: boundedTrimmedStringSchema(2000),
        slideIndex: z.number().int().min(1).optional(),
    })
    .strict();
const appUseSelectLayerParametersSchema = z
    .object({
        layerId: boundedTrimmedStringSchema(256).optional(),
        layerName: boundedTrimmedStringSchema(256).optional(),
    })
    .strict()
    .refine((value) => value.layerId !== undefined || value.layerName !== undefined, {
        message: 'select_layer requires layerId or layerName',
    });
const appUseExportPreviewParametersSchema = z
    .object({
        format: z.enum(['png', 'jpg', 'jpeg']).optional(),
        scale: z.number().min(0.1).max(4).optional(),
        selectionOnly: z.boolean().optional(),
    })
    .strict()
    .optional();
const appUseBatchExportParametersSchema = z
    .object({
        format: z.enum(['png', 'jpg', 'jpeg', 'pdf']).optional(),
        selectionOnly: z.boolean().optional(),
        artboardNames: z.array(boundedTrimmedStringSchema(256)).min(1).max(100).optional(),
        layerNames: z.array(boundedTrimmedStringSchema(256)).min(1).max(100).optional(),
    })
    .strict()
    .optional();
const appUseCrossAppTransferParametersSchema = z
    .object({
        sourceAdapterId: appUseAdapterIdSchema,
        targetAdapterId: appUseAdapterIdSchema,
        sourceTargetId: boundedTrimmedStringSchema(512).optional(),
        targetId: boundedTrimmedStringSchema(512).optional(),
        mode: z.enum(['copy_text', 'copy_cells', 'copy_slide_text']).optional(),
    })
    .strict();

const appUseParametersSchemaByAction: Partial<
    Record<AppUseActAction, z.ZodType<Record<string, unknown> | undefined>>
> = {
    insert_text: appUseTextActionParametersSchema,
    replace_selection: appUseTextActionParametersSchema,
    read_cells: appUseReadCellsParametersSchema,
    format_selection: appUseFormatSelectionParametersSchema,
    write_cells: appUseWriteCellsParametersSchema,
    add_slide_text: appUseAddSlideTextParametersSchema,
    select_layer: appUseSelectLayerParametersSchema,
    export_preview: appUseExportPreviewParametersSchema,
    batch_export: appUseBatchExportParametersSchema,
    cross_app_transfer: appUseCrossAppTransferParametersSchema,
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
        adapterId: appUseAdapterIdSchema,
        action: z.enum(APP_USE_ACT_ACTIONS),
        description: nonEmptyTrimmedStringSchema,
        targetId: z.string().trim().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()
    .superRefine((value, context) => {
        rejectRawAutomationParameters(value.parameters, context, ['parameters']);
        const parametersSchema = appUseParametersSchemaByAction[value.action];
        if (!parametersSchema) {
            return;
        }

        const parameters = parametersSchema.safeParse(value.parameters);
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
        const parametersSchema = appUseParametersSchemaByAction[value.action];
        if (!parametersSchema) {
            return value;
        }

        const parameters = parametersSchema.parse(value.parameters);
        if (parameters === undefined) {
            return {
                ...value,
                parameters: undefined,
            };
        }

        return {
            ...value,
            parameters,
        };
    });

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
                'Structured parameters for the bounded action. Use {text} for replace_selection and add_slide_text; use {range, values, sheetName?} for write_cells; use {bold?, italic?, underline?, fontSize?, fontName?} for format_selection. Raw scripts are not allowed.',
        },
    },
    required: ['adapterId', 'action', 'description'],
    additionalProperties: false,
};
