// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type {
    ComputerActionOperation,
    ComputerCapability,
    ComputerExecutionMode,
    ComputerObservationInclude,
    ComputerObservationMode,
    ComputerRouteHint,
    ComputerTarget,
} from '@services/NativeService';

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import {
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    z,
} from '../../utils/toolSchema';

export const COMPUTER_SESSION_TOOL_NAME = 'computer_session';
export const COMPUTER_OBSERVE_TOOL_NAME = 'computer_observe';
export const COMPUTER_ACT_TOOL_NAME = 'computer_act';

export interface ComputerToolConfig {
    timeoutMs: number;
    defaultExecutionMode: ComputerExecutionMode;
    providerHints: string[];
    enableVisionFallback: boolean;
}

export const DEFAULT_COMPUTER_TOOL_CONFIG: ComputerToolConfig = {
    timeoutMs: 8000,
    defaultExecutionMode: 'foreground',
    providerHints: ['native_windows', 'external_adapter'],
    enableVisionFallback: false,
};

export const computerCapabilityValues = [
    'native_tree',
    'screenshot',
    'background_actions',
    'vision_fallback',
    'browser_dom',
    'external_provider',
] as const satisfies readonly ComputerCapability[];

export const computerObservationModeValues = [
    'tree',
    'screenshot',
    'tree_and_screenshot',
] as const satisfies readonly ComputerObservationMode[];

export const computerObservationIncludeValues = [
    'displays',
    'windows',
    'tree',
    'screenshot',
] as const satisfies readonly ComputerObservationInclude[];

export const computerExecutionModeValues = [
    'foreground',
    'background',
] as const satisfies readonly ComputerExecutionMode[];

export const computerRouteHintValues = [
    'auto',
    'win32.send_input',
    'win32.message',
    'screen.capture',
    'unsupported',
] as const satisfies readonly ComputerRouteHint[];

export const computerActionOperationValues = [
    'click',
    'double_click',
    'right_click',
    'move',
    'drag',
    'scroll',
    'type_text',
    'press_key',
    'hotkey',
    'wait',
] as const satisfies readonly ComputerActionOperation[];

const targetSchemaBase = z
    .object({
        scope: z.enum(['foreground', 'screen', 'window', 'element', 'region']).optional(),
        label: z.string().trim().min(1).optional(),
        window: z
            .object({
                id: z.string().trim().min(1).optional(),
                title: z.string().trim().min(1).optional(),
                processName: z.string().trim().min(1).optional(),
            })
            .optional(),
        element: z
            .object({
                id: z.string().trim().min(1).optional(),
                role: z.string().trim().min(1).optional(),
                name: z.string().trim().min(1).optional(),
            })
            .optional(),
        coordinates: z
            .object({
                x: z.number().finite(),
                y: z.number().finite(),
                width: z.number().finite().positive().optional(),
                height: z.number().finite().positive().optional(),
                displayId: z.string().trim().min(1).optional(),
            })
            .optional(),
        windowId: z.string().trim().min(1).optional(),
        elementId: z.string().trim().min(1).optional(),
        displayId: z.string().trim().min(1).optional(),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        width: z.number().finite().positive().optional(),
        height: z.number().finite().positive().optional(),
    })
    .strict();

export const computerTargetSchema: z.ZodType<ComputerTarget> = targetSchemaBase
    .superRefine((target, ctx) => {
        const hasX = target.x !== undefined;
        const hasY = target.y !== undefined;
        if (hasX !== hasY) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'target.x and target.y must be provided together',
                path: hasX ? ['y'] : ['x'],
            });
        }

        const hasWidth = target.width !== undefined;
        const hasHeight = target.height !== undefined;
        if (hasWidth !== hasHeight) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'target.width and target.height must be provided together',
                path: hasWidth ? ['height'] : ['width'],
            });
        }

        if (target.coordinates) {
            const hasCoordinateWidth = target.coordinates.width !== undefined;
            const hasCoordinateHeight = target.coordinates.height !== undefined;
            if (hasCoordinateWidth !== hasCoordinateHeight) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message:
                        'target.coordinates.width and target.coordinates.height must be provided together',
                    path: ['coordinates', hasCoordinateWidth ? 'height' : 'width'],
                });
            }
        }
    })
    .transform((target) => target);

export const computerToolConfigSchema = z
    .object({
        timeoutMs: optionalIntegerInRangeSchema(1000, 120000).catch(undefined),
        defaultExecutionMode: z.enum(computerExecutionModeValues).optional().catch(undefined),
        providerHints: z.array(nonEmptyTrimmedStringSchema).optional().catch(undefined),
        enableVisionFallback: z.boolean().optional().catch(undefined),
    })
    .transform(
        (value): ComputerToolConfig => ({
            timeoutMs: value.timeoutMs ?? DEFAULT_COMPUTER_TOOL_CONFIG.timeoutMs,
            defaultExecutionMode:
                value.defaultExecutionMode ?? DEFAULT_COMPUTER_TOOL_CONFIG.defaultExecutionMode,
            providerHints:
                value.providerHints && value.providerHints.length > 0
                    ? value.providerHints
                    : DEFAULT_COMPUTER_TOOL_CONFIG.providerHints,
            enableVisionFallback:
                value.enableVisionFallback ?? DEFAULT_COMPUTER_TOOL_CONFIG.enableVisionFallback,
        })
    );

export const computerSessionArgsSchema = z
    .object({
        sessionId: z.string().trim().min(1).optional(),
        target: computerTargetSchema.default({ scope: 'foreground' }),
        capabilities: z.array(z.enum(computerCapabilityValues)).optional(),
        providerHints: z.array(nonEmptyTrimmedStringSchema).optional(),
        reason: nonEmptyTrimmedStringSchema,
    })
    .strict();

export const computerObserveArgsSchema = z
    .object({
        sessionId: nonEmptyTrimmedStringSchema,
        mode: z.enum(computerObservationModeValues).default('tree'),
        target: computerTargetSchema.default({ scope: 'foreground' }),
        include: z.array(z.enum(computerObservationIncludeValues)).optional(),
        reason: nonEmptyTrimmedStringSchema,
    })
    .strict();

export const computerActArgsSchema = z
    .object({
        sessionId: nonEmptyTrimmedStringSchema,
        operation: z.enum(computerActionOperationValues),
        target: computerTargetSchema,
        value: z.string().optional(),
        executionMode: z.enum(computerExecutionModeValues).optional(),
        routeHint: z.enum(computerRouteHintValues).optional(),
        dryRun: z.boolean().optional(),
        postActionObserve: z.boolean().optional(),
        reason: nonEmptyTrimmedStringSchema,
    })
    .strict()
    .superRefine((args, ctx) => {
        if (args.operation === 'type_text' && !args.value) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'value is required for type_text',
                path: ['value'],
            });
        }

        if ((args.operation === 'press_key' || args.operation === 'hotkey') && !args.value) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `value is required for ${args.operation}`,
                path: ['value'],
            });
        }
    });

export const COMPUTER_SESSION_TOOL_DESCRIPTION = [
    'Start a native-first computer-use session for the local desktop.',
    'Use this before observing or acting on the operating system UI.',
    'The tool reports available grounding lanes, action routes, and background-action support.',
].join(' ');

export const COMPUTER_OBSERVE_TOOL_DESCRIPTION = [
    'Observe the local desktop for a computer-use session.',
    'Prefer native UI tree grounding and keep screenshots as fallback when requested.',
    'Use the returned element IDs or coordinates to ground later computer_act calls.',
].join(' ');

export const COMPUTER_ACT_TOOL_DESCRIPTION = [
    'Execute one local desktop UI action for a computer-use session.',
    'This tool is native-first and runs at most once per model turn.',
    'Use observed element IDs whenever possible; coordinate targets require both x and y.',
].join(' ');

const targetInputSchema = {
    type: 'object',
    description:
        'Desktop target. Use scope foreground for the active window, elementId/windowId from computer_observe for native targets, or x/y coordinates for screen positions.',
    properties: {
        scope: {
            type: 'string',
            enum: ['foreground', 'screen', 'window', 'element', 'region'],
            description: 'Target scope.',
        },
        label: { type: 'string', description: 'Human-readable target label.' },
        window: {
            type: 'object',
            description: 'Native window target metadata.',
            properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                processName: { type: 'string' },
            },
            additionalProperties: false,
        },
        element: {
            type: 'object',
            description: 'Native element target metadata.',
            properties: {
                id: { type: 'string' },
                role: { type: 'string' },
                name: { type: 'string' },
            },
            additionalProperties: false,
        },
        coordinates: {
            type: 'object',
            description: 'Coordinate target. Use only as foreground fallback.',
            properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                displayId: { type: 'string' },
            },
            required: ['x', 'y'],
            additionalProperties: false,
        },
        windowId: { type: 'string', description: 'Native window identifier.' },
        elementId: { type: 'string', description: 'Native element identifier.' },
        displayId: { type: 'string', description: 'Display identifier.' },
        x: { type: 'number', description: 'Screen x coordinate. Requires y.' },
        y: { type: 'number', description: 'Screen y coordinate. Requires x.' },
        width: { type: 'number', description: 'Region width. Requires height.' },
        height: { type: 'number', description: 'Region height. Requires width.' },
    },
    additionalProperties: false,
} as const;

export const COMPUTER_SESSION_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        sessionId: {
            type: 'string',
            description:
                'Optional stable session id. Omit to let TouchAI create one from the tool call id.',
        },
        target: targetInputSchema,
        capabilities: {
            type: 'array',
            items: { type: 'string', enum: [...computerCapabilityValues] },
            description: 'Requested capabilities for this session.',
        },
        providerHints: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional provider hints for the native bridge.',
        },
        reason: {
            type: 'string',
            description: 'Why this desktop session is needed.',
        },
    },
    required: ['reason'],
    additionalProperties: false,
};

export const COMPUTER_OBSERVE_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        sessionId: { type: 'string', description: 'Session id returned by computer_session.' },
        mode: {
            type: 'string',
            enum: [...computerObservationModeValues],
            description:
                'Observation mode. Prefer tree for native grounding; request tree_and_screenshot only when screenshot fallback is needed.',
            default: 'tree',
        },
        target: targetInputSchema,
        include: {
            type: 'array',
            items: { type: 'string', enum: [...computerObservationIncludeValues] },
            description: 'Observation payload sections to return.',
        },
        reason: { type: 'string', description: 'Why this observation is needed.' },
    },
    required: ['sessionId', 'reason'],
    additionalProperties: false,
};

export const COMPUTER_ACT_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        sessionId: { type: 'string', description: 'Session id returned by computer_session.' },
        operation: {
            type: 'string',
            enum: [...computerActionOperationValues],
            description: 'Action operation to execute.',
        },
        target: targetInputSchema,
        value: {
            type: 'string',
            description: 'Text for type_text or key/key chord for press_key and hotkey.',
        },
        executionMode: {
            type: 'string',
            enum: [...computerExecutionModeValues],
            description:
                'foreground uses ordinary input. background is allowed only for native element or window targets.',
        },
        routeHint: {
            type: 'string',
            enum: [...computerRouteHintValues],
            description: 'Optional native route preference. auto is recommended.',
            default: 'auto',
        },
        dryRun: {
            type: 'boolean',
            description: 'Validate and resolve the action without applying it.',
            default: false,
        },
        postActionObserve: {
            type: 'boolean',
            description: 'Ask the native bridge to observe after the action.',
            default: false,
        },
        reason: { type: 'string', description: 'Why this desktop action is needed.' },
    },
    required: ['sessionId', 'operation', 'target', 'reason'],
    additionalProperties: false,
};
