import { getNextAppUpdateCheckAt, isWithinAppUpdateHours } from '@services/AppUpdateService/timing';
import { describe, expect, it } from 'vitest';

function localTime(day: number, hour: number, minute = 0): number {
    return new Date(2026, 9, day, hour, minute).getTime();
}

describe('app update check timing', () => {
    it('allows automatic checks only from 08:00 until midnight', () => {
        expect(isWithinAppUpdateHours(localTime(18, 0))).toBe(false);
        expect(isWithinAppUpdateHours(localTime(18, 7, 59))).toBe(false);
        expect(isWithinAppUpdateHours(localTime(18, 8))).toBe(true);
        expect(isWithinAppUpdateHours(localTime(18, 23, 59))).toBe(true);
    });

    it('waits until 08:00 during quiet hours and checks hourly during active hours', () => {
        expect(getNextAppUpdateCheckAt(localTime(18, 0))).toBe(localTime(18, 8));
        expect(getNextAppUpdateCheckAt(localTime(18, 7, 30))).toBe(localTime(18, 8));
        expect(getNextAppUpdateCheckAt(localTime(18, 8))).toBe(localTime(18, 9));
        expect(getNextAppUpdateCheckAt(localTime(18, 10, 30))).toBe(localTime(18, 11, 30));
        expect(getNextAppUpdateCheckAt(localTime(18, 23))).toBe(localTime(19, 8));
        expect(getNextAppUpdateCheckAt(localTime(18, 23, 30))).toBe(localTime(19, 8));
    });
});
