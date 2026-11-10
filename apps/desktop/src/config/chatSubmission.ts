export type SubmitShortcutMode = 'queue_on_enter' | 'priority_on_enter';

export const DEFAULT_SUBMIT_SHORTCUT_MODE: SubmitShortcutMode = 'queue_on_enter';

export function normalizeSubmitShortcutMode(value: unknown): SubmitShortcutMode {
    return value === 'priority_on_enter' ? 'priority_on_enter' : DEFAULT_SUBMIT_SHORTCUT_MODE;
}
