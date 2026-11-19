import {
    clampTimeoutMs,
    parseRequestedTimeoutMs,
    TOOL_TIMEOUT_META_KEY,
    TOOL_TIMEOUT_MIN_MS,
} from '@/utils/timeouts';

import type { ToolDeclaration } from '../contracts';

export function prepareDeclaration(input: ToolDeclaration): {
    declaration: ToolDeclaration;
    businessSchema: ToolDeclaration['input_schema'];
    sanitize(args: Record<string, unknown>): { args: Record<string, unknown>; timeout?: number };
} {
    const declaration = structuredClone(input);
    const businessSchema = structuredClone(declaration.input_schema);
    const ceiling = declaration.adaptiveTimeoutCeilingMs;
    const collision =
        TOOL_TIMEOUT_META_KEY in businessSchema.properties ||
        businessSchema.required?.includes(TOOL_TIMEOUT_META_KEY);
    const adaptive =
        ceiling !== undefined &&
        Number.isSafeInteger(ceiling) &&
        ceiling >= TOOL_TIMEOUT_MIN_MS &&
        !collision;
    if (adaptive) {
        declaration.input_schema.properties[TOOL_TIMEOUT_META_KEY] = {
            type: 'object',
            description: 'Optional execution metadata for this tool call.',
            properties: {
                timeoutMs: {
                    type: 'integer',
                    minimum: TOOL_TIMEOUT_MIN_MS,
                    maximum: ceiling,
                    description: `Optional timeout in milliseconds. Minimum: ${TOOL_TIMEOUT_MIN_MS} (1 second). Maximum: ${ceiling} milliseconds.`,
                },
            },
        };
    } else {
        delete declaration.adaptiveTimeoutCeilingMs;
    }
    return {
        declaration: freezeDeclaration(declaration),
        businessSchema,
        sanitize(args) {
            if (!adaptive) return { args };
            const parsed = parseRequestedTimeoutMs(args);
            return {
                args: parsed.sanitizedToolArgs,
                timeout:
                    parsed.requestedTimeoutMs !== undefined &&
                    parsed.requestedTimeoutMs >= TOOL_TIMEOUT_MIN_MS
                        ? clampTimeoutMs(parsed.requestedTimeoutMs, ceiling, ceiling)
                        : undefined,
            };
        },
    };
}

function freezeDeclaration<T>(value: T): T {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freezeDeclaration(child);
    return Object.freeze(value);
}
