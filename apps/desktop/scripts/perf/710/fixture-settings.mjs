const ANALYTICS_INSTALLATION_ID = '00000000-0000-4000-8000-000000000000';

export const FIXTURE_SETTING_TIMESTAMP = '1970-01-01 00:00:00';

function compareKeys(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function sortJsonKeys(value) {
    return Object.fromEntries(
        Object.keys(value)
            .sort(compareKeys)
            .map((key) => [key, value[key]])
    );
}

function normalizeSettingValue(value) {
    if (typeof value !== 'string') return value;
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch {
        return value;
    }
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !Object.hasOwn(parsed, 'installationId') ||
        !Object.hasOwn(parsed, 'updatedAtMs')
    ) {
        return value;
    }
    // These fields are created by app startup, not by the measured workload.
    return JSON.stringify(
        sortJsonKeys({
            ...parsed,
            installationId: ANALYTICS_INSTALLATION_ID,
            updatedAtMs: 0,
        })
    );
}

function indexRows(rows, arm) {
    const indexed = new Map();
    for (const row of rows) {
        if (!row || typeof row.key !== 'string') {
            throw new Error(`Fixture settings from ${arm} contain a row without a key`);
        }
        if (indexed.has(row.key)) {
            throw new Error(`Fixture settings from ${arm} contain duplicate key '${row.key}'`);
        }
        indexed.set(row.key, normalizeSettingValue(row.value));
    }
    return indexed;
}

export function canonicalizeSettingsRows(baselineRows, currentRows) {
    const baseline = indexRows(baselineRows, 'baseline');
    const current = indexRows(currentRows, 'current');
    const keys = [...new Set([...baseline.keys(), ...current.keys()])].sort(compareKeys);

    return keys.map((key, index) => {
        const baselineValue = baseline.get(key);
        const currentValue = current.get(key);
        if (baseline.has(key) && current.has(key) && baselineValue !== currentValue) {
            throw new Error(`Fixture setting '${key}' differs between arms`);
        }
        return {
            id: index + 1,
            key,
            value: current.has(key) ? currentValue : baselineValue,
        };
    });
}
