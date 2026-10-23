import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { buildUsageCurve } from '@/views/SettingsView/components/Usage/utils/usageOverlay';

/**
 * The history curve must place every trend bucket inside the plotted window.
 *
 * Bucket keys and the filter range are both UTC text, and the bucket width is
 * derived at query time. When either side disagreed, every point fell outside
 * the window and the curve rendered flat at zero.
 */
describe('buildUsageCurve', () => {
    const range = { preset: 'today', from: '2026-05-01 00:00:00', to: '2026-05-01 23:59:59' };

    function bucket(key: string, tokens: number) {
        return {
            key,
            requests: 1,
            tokens,
            costMicros: 10,
            segments: [{ groupId: 1, name: 'm', requests: 1, tokens, costMicros: 10 }],
        };
    }

    it('keeps points when the bucket width comes from the query layer', () => {
        setLocale('zh-CN');

        const curve = buildUsageCurve(
            [bucket('2026-05-01 10:30', 12_000), bucket('2026-05-01 11:00', 6000)],
            'minute',
            range,
            [],
            [],
            [],
            Date.parse('2026-05-01T12:00:00Z'),
            30 * 60_000
        );

        expect(curve.reduce((sum, point) => sum + point.value, 0)).toBeGreaterThan(0);
    });

    it('accepts every bucket key shape it can produce', () => {
        const shapes = [
            { key: '2026-05-01', kind: 'day' as const },
            { key: '2026-05-01 10:00', kind: 'hour' as const },
            { key: '2026-05-01 10:30', kind: 'minute' as const },
        ];

        for (const shape of shapes) {
            const curve = buildUsageCurve(
                [bucket(shape.key, 1000)],
                shape.kind,
                range,
                [],
                [],
                [],
                Date.parse('2026-05-01T12:00:00Z')
            );

            expect(curve.some((point) => point.value > 0)).toBe(true);
        }
    });

    it('aligns a live UTC range with UTC bucket keys', () => {
        setLocale('zh-CN');

        const now = new Date();
        const to = now.toISOString().slice(0, 19).replace('T', ' ');
        const from = new Date(now.getTime() - 6 * 3600_000)
            .toISOString()
            .slice(0, 19)
            .replace('T', ' ');

        const bucketMs = 1_800_000;
        const aligned = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
        const key =
            [
                aligned.getUTCFullYear(),
                String(aligned.getUTCMonth() + 1).padStart(2, '0'),
                String(aligned.getUTCDate()).padStart(2, '0'),
            ].join('-') +
            ` ${String(aligned.getUTCHours()).padStart(2, '0')}:${String(aligned.getUTCMinutes()).padStart(2, '0')}`;

        const curve = buildUsageCurve(
            [bucket(key, 60_000)],
            'minute',
            { preset: 'today', from, to },
            [],
            [],
            [],
            now.getTime(),
            bucketMs
        );

        expect(curve.reduce((sum, point) => sum + point.value, 0)).toBeGreaterThan(0);
    });
});
