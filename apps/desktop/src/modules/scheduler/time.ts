import { Cron } from 'croner';

import type { CronTrigger } from './types';

export interface WallClock {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const HOUR = 60 * 60 * 1_000;
const MAX_WALL_OCCURRENCES = 20_000;

function formatter(timezone: string): Intl.DateTimeFormat {
    const cached = formatterCache.get(timezone);
    if (cached) return cached;
    const created = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    formatterCache.set(timezone, created);
    return created;
}

function wallClockAt(timestamp: number, timezone: string): WallClock {
    const values = new Map(
        formatter(timezone)
            .formatToParts(new Date(timestamp))
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, Number(part.value)])
    );
    return {
        year: values.get('year')!,
        month: values.get('month')!,
        day: values.get('day')!,
        hour: values.get('hour')!,
        minute: values.get('minute')!,
        second: values.get('second')!,
    };
}

function wallClockMilliseconds(wall: WallClock): number {
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

function offsetAt(timestamp: number, timezone: string): number {
    return (
        wallClockMilliseconds(wallClockAt(timestamp, timezone)) -
        Math.floor(timestamp / 1_000) * 1_000
    );
}

function sameWallClock(left: WallClock, right: WallClock): boolean {
    return (
        left.year === right.year &&
        left.month === right.month &&
        left.day === right.day &&
        left.hour === right.hour &&
        left.minute === right.minute &&
        left.second === right.second
    );
}

function resolveWallClock(timestamp: number, timezone: string): number[] {
    const target = wallClockAt(timestamp, 'UTC');
    const targetMilliseconds = wallClockMilliseconds(target);
    const offsets = new Set([
        offsetAt(targetMilliseconds - 36 * HOUR, timezone),
        offsetAt(targetMilliseconds, timezone),
        offsetAt(targetMilliseconds + 36 * HOUR, timezone),
    ]);
    return [...offsets]
        .map((offset) => targetMilliseconds - offset)
        .filter((candidate) => sameWallClock(target, wallClockAt(candidate, timezone)))
        .filter((candidate, index, values) => values.indexOf(candidate) === index)
        .sort((left, right) => left - right);
}

export function isValidTimezone(timezone: string): boolean {
    try {
        formatter(timezone).format();
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve a wall-clock value in an IANA zone. A nonexistent spring-forward
 * value returns null; a duplicated fall-back value uses its first occurrence.
 */
export function zonedDateTimeToTimestamp(value: WallClock, timezone: string): number | null {
    if (!isValidTimezone(timezone)) return null;
    const normalized = new Date(
        Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second)
    );
    if (
        normalized.getUTCFullYear() !== value.year ||
        normalized.getUTCMonth() + 1 !== value.month ||
        normalized.getUTCDate() !== value.day ||
        normalized.getUTCHours() !== value.hour ||
        normalized.getUTCMinutes() !== value.minute ||
        normalized.getUTCSeconds() !== value.second
    ) {
        return null;
    }
    return resolveWallClock(normalized.getTime(), timezone)[0] ?? null;
}

export function nextCronOccurrence(
    trigger: CronTrigger,
    timezone: string,
    from: Date
): number | null {
    const cron = new Cron(trigger.expression, { paused: true, timezone });
    return cron.nextRun(from)?.getTime() ?? null;
}

/**
 * Croner skips nonexistent and duplicate wall-clock matches correctly. This
 * detector only supplies the explicit skipped_dst history entry required by the
 * product contract; it does not schedule tasks.
 */
export function findSkippedDstOccurrences(input: {
    trigger: CronTrigger;
    timezone: string;
    from: number;
    until: number;
}): number[] {
    if (
        !Number.isFinite(input.from) ||
        !Number.isFinite(input.until) ||
        input.until <= input.from
    ) {
        return [];
    }

    const floating = new Cron(input.trigger.expression, {
        paused: true,
        timezone: 'UTC',
    });
    const firstWall = wallClockMilliseconds(wallClockAt(input.from, input.timezone));
    const lastWall = wallClockMilliseconds(wallClockAt(input.until, input.timezone));
    const transitionWindows: Array<{ start: number; end: number; offsetBefore: number }> = [];
    let sampleAt = input.from;
    let previousOffset = offsetAt(sampleAt, input.timezone);

    while (sampleAt < input.until) {
        const nextSample = Math.min(sampleAt + 6 * HOUR, input.until);
        const currentOffset = offsetAt(nextSample, input.timezone);
        if (currentOffset !== previousOffset) {
            transitionWindows.push({
                start: wallClockMilliseconds(wallClockAt(sampleAt, input.timezone)) - 48 * HOUR,
                end: wallClockMilliseconds(wallClockAt(nextSample, input.timezone)) + 48 * HOUR,
                offsetBefore: previousOffset,
            });
        }
        sampleAt = nextSample;
        previousOffset = currentOffset;
    }

    const skipped = new Set<number>();
    for (const window of transitionWindows) {
        let candidate =
            floating.nextRun(new Date(Math.max(firstWall, window.start)))?.getTime() ?? null;
        let attempts = 0;
        while (candidate !== null && candidate <= Math.min(lastWall, window.end)) {
            if (resolveWallClock(candidate, input.timezone).length === 0) {
                const scheduledFor = candidate - window.offsetBefore;
                if (scheduledFor > input.from && scheduledFor <= input.until) {
                    skipped.add(scheduledFor);
                }
            }
            attempts += 1;
            if (attempts >= MAX_WALL_OCCURRENCES) break;
            candidate = floating.nextRun(new Date(candidate))?.getTime() ?? null;
        }
    }

    return [...skipped].sort((left, right) => left - right);
}
