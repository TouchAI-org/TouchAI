/**
 * ShowWidget may execute only when the model explicitly confirms that it read the built-in guide.
 * The confirmation is public and is never used as an authorization secret.
 */
export const SKILL_ACKNOWLEDGEMENT_FIELD = 'is_read_widget_skill' as const;
