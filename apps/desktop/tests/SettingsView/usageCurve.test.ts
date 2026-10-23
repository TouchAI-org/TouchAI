import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import {
    buildUsageCurve,
    localUsageKey,
    parseUsageTime,
} from '@/views/SettingsView/components/Usage/utils/usageOverlay';

/**
 * The history curve takes a bucket width from the query layer, and both sides
 * must agree on the bucket key text.
 *
 * When they disagreed, either on the width or on UTC versus local time, every
 * point fell outside the window and the curve rendered flat at zero.
 */
describe('history curve placement', () => {
    const range = { preset: 'today', from: '2026-05-01 00:00:00', to: '2026-05-01 23:59:59' };
    const bucketMs = 30 * 60_000;
    const kind = 'minute' as const;

    function bucket(key: string, tokens: number) {
        return {
            key,
            requests: 1,
            tokens,
            costMicros: 10,
            segments: [{ groupId: 1, name: 'm', requests: 1, tokens, costMicros: 10 }],
        };
    }

    function total(...keys: Array<[string, number]>) {
        return buildUsageCurve(
            keys.map(([key, tokens]) => bucket(key, tokens)),
            kind,
            range,
            [],
            [],
            [],
            Date.parse('2026-05-01T12:00:00Z'),
            bucketMs
        ).reduce((sum, point) => sum + point.value, 0);
    }

    it('places points when the width comes from the query layer', () => {
        setLocale('zh-CN');

        expect(total(['2026-05-01 10:30', 12_000], ['2026-05-01 11:00', 6000])).toBeGreaterThan(0);
    });

    it('produces the same bucket key the query layer formats', () => {
        const instant = new Date(Date.UTC(2026, 4, 1, 10, 45, 0));

        expect(localUsageKey(instant, kind, bucketMs)).toBe('2026-05-01 10:30');
    });

    it('round-trips a key back to the bucket start', () => {
        const key = localUsageKey(new Date(Date.UTC(2026, 4, 1, 10, 45, 0)), kind, bucketMs);

        expect(parseUsageTime(key)).toBe(Date.UTC(2026, 4, 1, 10, 30, 0));
    });

    it('aligns every instant inside one bucket to the same key', () => {
        const keys = [0, 5, 17, 29].map((minute) =>
            localUsageKey(new Date(Date.UTC(2026, 4, 1, 10, minute, 0)), kind, bucketMs)
        );

        expect(new Set(keys).size).toBe(1);
    });

    it('separates adjacent buckets', () => {
        const first = localUsageKey(new Date(Date.UTC(2026, 4, 1, 10, 29, 0)), kind, bucketMs);
        const next = localUsageKey(new Date(Date.UTC(2026, 4, 1, 10, 31, 0)), kind, bucketMs);

        expect(first).not.toBe(next);
    });

    it('accepts every bucket key shape it can produce', () => {
        for (const shape of [
            { key: '2026-05-01', kind: 'day' as const, width: undefined },
            { key: '2026-05-01 10:00', kind: 'hour' as const, width: undefined },
            { key: '2026-05-01 10:30', kind: 'minute' as const, width: bucketMs },
        ]) {
            const curve = buildUsageCurve(
                [bucket(shape.key, 1000)],
                shape.kind,
                range,
                [],
                [],
                [],
                Date.parse('2026-05-01T12:00:00Z'),
                shape.width
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

        const aligned = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
        const key = localUsageKey(aligned, kind, bucketMs);

        const curve = buildUsageCurve(
            [bucket(key, 60_000)],
            kind,
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
