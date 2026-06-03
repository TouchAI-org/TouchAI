export function clampTimeoutMs(
    requested: number | undefined | null,
    fallback: number,
    min = 1000,
    max = 600000
): number {
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
        return fallback;
    }
    const integer = Math.floor(requested);
    const bounded = Math.min(Math.max(integer, min), max);
    return bounded;
}
