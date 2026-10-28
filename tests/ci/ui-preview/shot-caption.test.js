import { describe, expect, it } from 'vitest';

import {
    accurateSearchCaption,
    COMPACT_SEARCH_CAPTION,
} from '../../../.github/ui-preview/lib/shot-caption.mjs';

describe('user reads an accurate compact search caption', () => {
    it('user does not see a results claim when no results panel appeared', () => {
        expect(accurateSearchCaption('Expanded results at content height', false)).toBe(
            COMPACT_SEARCH_CAPTION
        );
    });

    it('user keeps a neutral caption for the query-only state', () => {
        expect(accurateSearchCaption('Query typed in the search bar', false)).toBe(
            'Query typed in the search bar'
        );
    });

    it('user keeps the model caption when results are visible', () => {
        expect(accurateSearchCaption('Expanded results at content height', true)).toBe(
            'Expanded results at content height'
        );
    });
});
