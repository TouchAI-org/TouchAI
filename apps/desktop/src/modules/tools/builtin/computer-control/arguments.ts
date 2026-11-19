export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeArguments(
    outer: Record<string, unknown>,
    nested: Record<string, unknown>
): Record<string, unknown> {
    for (const key of Object.keys(nested)) {
        if (
            outer[key] !== undefined &&
            JSON.stringify(outer[key]) !== JSON.stringify(nested[key])
        ) {
            throw new Error(`conflicting_argument:${key}; provide this field in one place`);
        }
    }
    return { ...outer, ...nested };
}

export function normalizeComputerUseArguments(
    input: Record<string, unknown>
): Record<string, unknown> {
    const { arguments: nested, ...outer } = input;
    if (nested !== undefined && !isRecord(nested)) {
        throw new Error('arguments_must_be_an_object');
    }
    if (
        input.action === 'call' &&
        isRecord(nested) &&
        typeof nested.tool === 'string' &&
        isRecord(nested.arguments)
    ) {
        input = mergeArguments(outer, nested);
    }
    if (input.action === 'call' || input.action === 'run_steps' || input.action === 'run_script') {
        const { action, tool, arguments: nativeArgs, ...fields } = input;
        return {
            action,
            ...(tool === undefined ? {} : { tool }),
            arguments: mergeArguments(fields, isRecord(nativeArgs) ? nativeArgs : {}),
        };
    }
    return isRecord(nested) ? mergeArguments(outer, nested) : input;
}
