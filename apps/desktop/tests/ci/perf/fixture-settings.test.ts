import { describe, expect, it } from 'vitest';

import { canonicalizeSettingsRows } from '../../../scripts/perf/710/fixture-settings.mjs';

function analyticsState(installationId: string, updatedAtMs: number): string {
    return JSON.stringify({
        policyVersion: 1,
        status: 'enabled',
        consentExplicit: 0,
        installationId,
        consentEpoch: 0,
        updatedAtMs,
    });
}

describe('user prepares equivalent RFC 710 fixture settings', () => {
    it('user sees the union of version-specific defaults with stable ids', () => {
        const result = canonicalizeSettingsRows(
            [{ key: 'global_shortcut', value: 'Alt+Space' }],
            [
                { key: 'animation_speed', value: 'standard' },
                { key: 'global_shortcut', value: 'Alt+Space' },
            ]
        );

        expect(result).toEqual([
            { id: 1, key: 'animation_speed', value: 'standard' },
            { id: 2, key: 'global_shortcut', value: 'Alt+Space' },
        ]);
    });

    it('user does not compare analytics identity and update time as business data', () => {
        const result = canonicalizeSettingsRows(
            [{ key: 'analytics_state', value: analyticsState('baseline-install', 1) }],
            [{ key: 'analytics_state', value: analyticsState('current-install', 2) }]
        );

        expect(result).toHaveLength(1);
        const row = result[0];
        if (!row) throw new Error('Expected a canonical analytics setting');
        expect(JSON.parse(row.value ?? '{}')).toMatchObject({
            installationId: '00000000-0000-4000-8000-000000000000',
            updatedAtMs: 0,
        });
    });

    it('user cannot benchmark when a shared setting has different values', () => {
        expect(() =>
            canonicalizeSettingsRows(
                [{ key: 'language', value: 'zh-CN' }],
                [{ key: 'language', value: 'en-US' }]
            )
        ).toThrow("Fixture setting 'language' differs between arms");
    });
});
