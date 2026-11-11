const SUPPORTED_LOCALES = new Set(['en', 'en-US', 'zh-CN']);
const MAX_NOTES_LENGTH = 64 * 1024;

export function normalizeLocalizedReleaseNotes(value) {
    if (value === undefined || value === null) {
        return {};
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('releaseNotesByLocale must be an object.');
    }

    const notes = {};
    for (const [locale, content] of Object.entries(value)) {
        if (!SUPPORTED_LOCALES.has(locale)) {
            throw new Error(`Unsupported release notes locale: ${locale}.`);
        }
        if (typeof content !== 'string' || content.length > MAX_NOTES_LENGTH) {
            throw new Error(
                `Release notes for ${locale} must be a string of at most 65536 characters.`
            );
        }
        if (content.trim()) {
            notes[locale] = content.trim();
        }
    }
    return notes;
}

export function legacyEnglishReleaseNotes(value) {
    const notes = normalizeLocalizedReleaseNotes(value);
    const english = notes['en-US'] ?? notes.en;
    if (!english) {
        throw new Error('Release notes must include en-US.');
    }
    return english;
}
