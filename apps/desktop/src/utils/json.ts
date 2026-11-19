/** Keep array order and canonicalize object keys for semantic equality. */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const object = entry as Record<string, unknown>;
        return Object.fromEntries(
            Object.keys(object)
                .sort()
                .map((key) => [key, object[key]])
        );
    });
}
