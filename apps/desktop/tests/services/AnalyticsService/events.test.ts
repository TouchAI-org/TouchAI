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

describe('AnalyticsService event registry', () => {
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

    it('user gets four-digit years 0000-0099 accepted and impossible days rejected', () => {
        const validateDay = (first_observed_day: string) =>
            validateAnalyticsAttributes('analytics.session_started', {
                configured: true,
                first_observed_day,
            });

        // The Rust `time` validator accepts the full four-digit range; the
        // TypeScript registry must agree rather than dropping years 0-99.
        expect(() => validateDay('0000-01-01')).not.toThrow();
        expect(() => validateDay('0099-12-31')).not.toThrow();
        expect(() => validateDay('2026-02-29')).toThrow();
        expect(() => validateDay('2026-13-01')).toThrow();
    });
});
