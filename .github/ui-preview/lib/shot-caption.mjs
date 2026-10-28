const RESULT_CLAIM = /\b(?:expanded|results?|content\s+height)\b/i;

export const COMPACT_SEARCH_CAPTION = 'Compact search window; no results panel is visible';

export function accurateSearchCaption(caption, expanded) {
    const value = String(caption ?? '').trim();

    if (expanded || !RESULT_CLAIM.test(value)) {
        return value;
    }

    return COMPACT_SEARCH_CAPTION;
}
