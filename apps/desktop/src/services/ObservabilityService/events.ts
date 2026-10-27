import { z } from 'zod';

import { ATTR } from './attributes';
import { OBSERVABILITY_ERROR_CODES } from './errors';
import type { LogLevelName } from './types';

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const boundedString = z.string().max(256);
const errorAttributes = {
    [ATTR.errorCode]: z.enum(OBSERVABILITY_ERROR_CODES),
    'error.type': boundedString,
};
const providerAttributes = {
    [ATTR.providerName]: boundedString.optional(),
    [ATTR.requestModel]: boundedString.optional(),
};

export interface ObservabilityEventDefinition {
    level: LogLevelName;
    attrs: z.ZodType<Record<string, string | number | boolean>>;
    telemetry: boolean;
}

/**
 * Typed critical events. Add event definitions here before enabling their
 * telemetry; free-form service logs remain available through `log.*`.
 */
export const OBSERVABILITY_EVENTS = {
    'app.start': {
        level: 'info',
        attrs: z
            .object({
                [ATTR.window]: boundedString.optional(),
            })
            .strict(),
        telemetry: true,
    },
    'agent.request.failed': {
        level: 'error',
        attrs: z
            .object({
                ...providerAttributes,
                ...errorAttributes,
                [ATTR.httpStatus]: z.number().int().min(100).max(599).optional(),
                [ATTR.retryable]: z.boolean().optional(),
            })
            .strict(),
        telemetry: true,
    },
    'agent.retry.scheduled': {
        level: 'warn',
        attrs: z
            .object({
                [ATTR.attempt]: z.number().int().positive(),
                [ATTR.errorCode]: z.enum(OBSERVABILITY_ERROR_CODES),
            })
            .strict(),
        telemetry: true,
    },
    'agent.tool.completed': {
        level: 'info',
        attrs: z
            .object({
                [ATTR.toolCallId]: boundedString,
                [ATTR.toolName]: boundedString,
                'tool.success': z.boolean(),
            })
            .strict(),
        telemetry: true,
    },
    'mcp.connect.failed': {
        level: 'error',
        attrs: z.object(errorAttributes).strict(),
        telemetry: true,
    },
    'mcp.tool.completed': {
        level: 'info',
        attrs: z
            .object({
                [ATTR.toolCallId]: boundedString,
                [ATTR.toolName]: boundedString,
                'tool.success': z.boolean(),
                [ATTR.durationMs]: z.number().nonnegative(),
            })
            .strict(),
        telemetry: true,
    },
    'obs.dropped': {
        level: 'warn',
        attrs: z.record(z.string(), scalar),
        telemetry: false,
    },
    'external.console': {
        level: 'warn',
        attrs: z.record(z.string(), scalar),
        telemetry: false,
    },
    'obs.schema.invalid': {
        level: 'error',
        attrs: z
            .object({
                'obs.event': boundedString,
            })
            .strict(),
        telemetry: false,
    },
} as const satisfies Record<string, ObservabilityEventDefinition>;

export type ObservabilityEventName = keyof typeof OBSERVABILITY_EVENTS;
export type ObservabilityEventAttributes<T extends ObservabilityEventName> = z.infer<
    (typeof OBSERVABILITY_EVENTS)[T]['attrs']
>;

export function validateEventAttributes(
    event: ObservabilityEventName,
    attrs: Record<string, string | number | boolean>
): void {
    if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
    OBSERVABILITY_EVENTS[event].attrs.parse(attrs);
}
