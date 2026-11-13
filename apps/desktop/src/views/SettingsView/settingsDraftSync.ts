type JsonObject = Record<string, unknown>;

const NO_CHANGES = Symbol('no-changes');

function isJsonObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function createPatch(base: unknown, draft: unknown): unknown | typeof NO_CHANGES {
    if (Object.is(base, draft)) {
        return NO_CHANGES;
    }
    if (!isJsonObject(base) || !isJsonObject(draft)) {
        return cloneJsonValue(draft);
    }

    const patch: JsonObject = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
        const childPatch = createPatch(base[key], draft[key]);
        if (childPatch !== NO_CHANGES) {
            patch[key] = childPatch;
        }
    }
    return Object.keys(patch).length > 0 ? patch : NO_CHANGES;
}

function applyPatch(target: unknown, patch: unknown): unknown {
    if (!isJsonObject(target) || !isJsonObject(patch)) {
        return cloneJsonValue(patch);
    }

    const next = cloneJsonValue(target);
    for (const [key, value] of Object.entries(patch)) {
        next[key] = isJsonObject(value) ? applyPatch(next[key], value) : cloneJsonValue(value);
    }
    return next;
}

export function mergeSettingsDraft<T extends object>(baseline: T, draft: T, incoming: T): T {
    const patch = createPatch(baseline, draft);
    return (patch === NO_CHANGES ? cloneJsonValue(incoming) : applyPatch(incoming, patch)) as T;
}

export function hasSettingsDraftChanges<T extends object>(baseline: T, draft: T): boolean {
    return createPatch(baseline, draft) !== NO_CHANGES;
}
