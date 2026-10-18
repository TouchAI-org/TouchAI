export const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const APP_UPDATE_START_HOUR = 8;

export function isWithinAppUpdateHours(timestamp: number): boolean {
    return new Date(timestamp).getHours() >= APP_UPDATE_START_HOUR;
}

export function getNextAppUpdateCheckAt(timestamp: number): number {
    const next = new Date(
        isWithinAppUpdateHours(timestamp) ? timestamp + AUTO_CHECK_INTERVAL_MS : timestamp
    );
    if (next.getHours() < APP_UPDATE_START_HOUR) {
        next.setHours(APP_UPDATE_START_HOUR, 0, 0, 0);
    }
    return next.getTime();
}
