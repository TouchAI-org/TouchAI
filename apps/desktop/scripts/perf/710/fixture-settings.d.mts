export interface FixtureSettingRow {
    key: string;
    value: string | null;
}

export interface CanonicalFixtureSettingRow extends FixtureSettingRow {
    id: number;
}

export const FIXTURE_SETTING_TIMESTAMP: string;

export function canonicalizeSettingsRows(
    baselineRows: readonly FixtureSettingRow[],
    currentRows: readonly FixtureSettingRow[]
): CanonicalFixtureSettingRow[];
