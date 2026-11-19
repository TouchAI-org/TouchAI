import { getNextAppUpdateCheckAt, isWithinAppUpdateHours } from '@/modules/updates';
import { log } from '@/platform/diagnostics';

interface AutomaticUpdates {
    checkNow(source: 'automatic'): Promise<boolean>;
    getAutomaticCheckInterval(): number;
    getLastCheckAttemptAt(): string | null;
}

/** Preserve the existing quiet-hours/deadline policy in the main window lifetime. */
export function startAutomaticUpdateChecks(
    updates: AutomaticUpdates,
    initializeReminders: () => Promise<void>
): () => void {
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
        if (stopped || running) return;
        clearTimeout(timer);
        timer = undefined;
        running = true;
        const now = Date.now();
        const checked = isWithinAppUpdateHours(now)
            ? await updates.checkNow('automatic').catch((error) => {
                  log.warn('[Updates] Automatic update check failed:', error);
                  return false;
              })
            : false;
        running = false;
        if (stopped) return;
        const interval = updates.getAutomaticCheckInterval();
        if (!checked) {
            const attemptAt = Date.parse(updates.getLastCheckAttemptAt() ?? '');
            const hasLiveDeadline =
                isWithinAppUpdateHours(now) &&
                Number.isFinite(attemptAt) &&
                attemptAt + interval > now;
            let retryAt = getNextAppUpdateCheckAt(hasLiveDeadline ? attemptAt : now, interval);
            if (retryAt <= now) retryAt = getNextAppUpdateCheckAt(now, interval);
            timer = setTimeout(run, Math.max(0, retryAt - now));
            return;
        }
        const completedAt = Date.now();
        timer = setTimeout(run, getNextAppUpdateCheckAt(completedAt, interval) - completedAt);
    };
    const onOnline = () => {
        void run();
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('pagehide', stop);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', stop, { once: true });
    void initializeReminders()
        .catch((error) => log.warn('[Updates] Failed to initialize reminders:', error))
        .finally(run);
    return stop;
}
