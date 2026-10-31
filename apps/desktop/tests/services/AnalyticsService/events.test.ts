import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ANALYTICS_EVENT_SCHEMAS,
    validateAnalyticsAttributes,
} from '@services/AnalyticsService/events';
import { ANALYTICS_EVENT_NAMES, type AnalyticsAttributes } from '@services/AnalyticsService/types';
import { describe, expect, it } from 'vitest';

interface FixtureEvent {
    name: string;
    attributes: AnalyticsAttributes;
}

function loadFixtures(file: string): FixtureEvent[] {
    const path = resolve('src/services/AnalyticsService/fixtures', file);
    const document = JSON.parse(readFileSync(path, 'utf8')) as { events: FixtureEvent[] };
    return document.events;
}

describe('given a product event is submitted for validation', () => {
    it('user gets the fixture registry covering every registered event', () => {
        const names = loadFixtures('analytics-events.v1.json').map((event) => event.name);

        expect(names).toHaveLength(19);
        expect(new Set(names)).toEqual(new Set(ANALYTICS_EVENT_NAMES));
    });

    it('user gets every valid fixture accepted with its whitelist attributes', () => {
        for (const { name, attributes } of loadFixtures('analytics-events.v1.json')) {
            expect(() => validateAnalyticsAttributes(name as never, attributes)).not.toThrow();
        }
    });

    it('user gets unknown events and out-of-range or unknown attributes rejected', () => {
        for (const { name, attributes } of loadFixtures('analytics-events.invalid.v1.json')) {
            expect(() => validateAnalyticsAttributes(name as never, attributes)).toThrow();
        }
    });

    it('user gets an unregistered event name rejected before persistence', () => {
        expect(() =>
            validateAnalyticsAttributes('analytics.not_registered' as never, {})
        ).toThrow();
    });

    it('user gets the schema set and the event name list kept in step', () => {
        expect(Object.keys(ANALYTICS_EVENT_SCHEMAS).sort()).toEqual(
            [...ANALYTICS_EVENT_NAMES].sort()
        );
    });

    it('user gets only real days in years 1 through 9999 accepted when submitting observation dates', () => {
        const path = resolve('src/services/AnalyticsService/fixtures/analytics-days.v1.json');
        const { cases } = JSON.parse(readFileSync(path, 'utf8')) as {
            cases: { day: string; accepted: boolean }[];
        };

        // Rust consumes this same table; the receiver requires real years 1-9999.
        for (const { day, accepted } of cases) {
            for (const key of ['first_observed_day', 'first_success_day']) {
                const result = ANALYTICS_EVENT_SCHEMAS['analytics.session_started'].safeParse({
                    configured: true,
                    [key]: day,
                });
                expect(result.success, `${key}: ${JSON.stringify(day)}`).toBe(accepted);
            }
        }
    });

    it('user gets a release version accepted only in the shared version shape', () => {
        // The Rust registry applies the identical rule, so both validator copies
        // and the private receiver accept and reject exactly the same strings.
        const cases: [string, boolean][] = [
            ['1.2.3', true],
            ['1.2.3-beta.1+build.5', true],
            ['2026.10.1', true],
            ['0', true],
            ['1'.repeat(64), true],
            ['1'.repeat(65), false],
            ['', false],
            ['-1.2.3', false],
            ['.1.2.3', false],
            ['/tmp/release/1.2.3', false],
            ['https://updates.touch-ai.org/1.2.3', false],
            ['Error: failed to read src/main.rs', false],
            ['openai/gpt-4o', false],
            ['gpt-4o:latest', false],
            ['1.2.3 ', false],
            ['1.2.3\n', false],
            ['1.2.3\r\n', false],
            ['1.2.3\u2028', false],
            ['1.2.3_rc1', false],
            ['1.2.3\u4e2d\u6587', false],
        ];
        const update = (from_version: string, to_version: string) => ({
            update_operation_id: '8192a3b4-c5d6-4ae7-9b08-d9eafb0c1d08',
            phase: 'check_started' as const,
            from_version,
            to_version,
            result: 'success' as const,
            source: 'background' as const,
        });

        for (const [value, accepted] of cases) {
            for (const attributes of [update(value, '1.2.3'), update('1.2.3', value)]) {
                let rejected = false;
                try {
                    validateAnalyticsAttributes('app.update_transition', attributes);
                } catch {
                    rejected = true;
                }
                expect(rejected, `version ${JSON.stringify(value)}`).toBe(!accepted);
            }
        }
    });
});
