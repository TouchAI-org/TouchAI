export interface FormatCompactDurationOptions {
    minimumUnit?: 'millisecond' | 'second';
    rounding?: 'round' | 'floor' | 'ceil';
    clampToOneSecond?: boolean;
}

function normalizeDurationSeconds(
    durationMs: number,
    options: FormatCompactDurationOptions
): number {
    const rounding = options.rounding ?? 'round';
    const round = rounding === 'floor' ? Math.floor : rounding === 'ceil' ? Math.ceil : Math.round;
    const roundedSeconds = Math.max(0, round(durationMs / 1000));

    if (options.clampToOneSecond && durationMs > 0) {
        return Math.max(1, roundedSeconds);
    }

    return roundedSeconds;
}

export function formatCompactDuration(
    durationMs?: number | null,
    options: FormatCompactDurationOptions = {}
): string | null {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
        return null;
    }

    if ((options.minimumUnit ?? 'millisecond') === 'millisecond' && durationMs < 1000) {
        return `${Math.round(durationMs)}ms`;
    }

    const totalSeconds = normalizeDurationSeconds(durationMs, options);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m ${seconds}s`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
}

export function parseMillisecondDurationLabel(durationText?: string | null): number | null {
    if (typeof durationText !== 'string') {
        return null;
    }

    const trimmed = durationText.trim();
    if (!trimmed) {
        return null;
    }

    const match = trimmed.match(/^(\d+)ms$/i);
    if (!match) {
        return null;
    }

    return Number(match[1]);
}
