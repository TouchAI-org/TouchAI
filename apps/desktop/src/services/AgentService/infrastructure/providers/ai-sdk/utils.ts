// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { JSONSchema7 } from 'ai';

import type { JsonObject, JsonValue } from '@/services/AgentService/contracts/protocol';

export function normalizeToolName(toolName: string | undefined): string | undefined {
    const normalized = toolName?.trim();
    return normalized ? normalized : undefined;
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isJsonValue(value: unknown): value is JsonValue {
    if (isJsonPrimitive(value)) {
        return true;
    }

    if (Array.isArray(value)) {
        return value.every((item) => isJsonValue(item));
    }

    return isJsonObject(value);
}

function isJsonObject(value: unknown): value is JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    return Object.values(value).every((item) => item === undefined || isJsonValue(item));
}

function isJsonSchemaType(value: unknown): value is JSONSchema7['type'] {
    return (
        typeof value === 'string' ||
        (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    );
}

function isJsonSchema7Object(value: unknown): value is JSONSchema7 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const schemaType = Reflect.get(value, 'type');
    return schemaType === undefined || isJsonSchemaType(schemaType);
}

export function toJsonObjectRecord(value: unknown): Record<string, JsonObject> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const normalized: Record<string, JsonObject> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!isJsonObject(entry)) {
            return undefined;
        }
        normalized[key] = entry;
    }

    return normalized;
}

export function toJsonSchema7(value: unknown): JSONSchema7 | null {
    return isJsonSchema7Object(value) ? value : null;
}
