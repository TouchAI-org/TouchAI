import { describe, expect, it } from 'vitest';

import { previewCardVariants, previewTextVariants } from '@/components/ui/preview-card';

// Appearance classes are the design-system primitive contract.
describe('given the existing conversation previews share their appearance', () => {
    it('user reads a scrolling preview then its existing compact card appearance stays unchanged', () => {
        expect(previewCardVariants({ variant: 'scroll' })).toMatchInlineSnapshot(
            '"rounded-lg border border-border-subtle bg-background-primary p-3 font-serif shadow-lg"'
        );
    });

    it('user reads a reference preview then its existing floating surface and elevation are shared', () => {
        expect(previewCardVariants({ variant: 'reference' })).toMatchInlineSnapshot(
            '"rounded-panel bg-surface-floating p-3 shadow-hover-preview"'
        );
    });

    it('user reads a compact in-conversation preview then it uses the smaller shared surface', () => {
        expect(previewCardVariants({ variant: 'reference-compact' })).toMatchInlineSnapshot(
            '"rounded-control border border-border bg-surface-floating px-2.5 py-2 font-serif shadow-preview-compact"'
        );
    });

    it('user reads preview text then the existing title and description typography stay unchanged', () => {
        expect(previewTextVariants({ variant: 'title' })).toBe(
            'text-compact font-medium text-text-primary'
        );
        expect(previewTextVariants({ variant: 'description' })).toBe(
            'text-caption leading-5 text-text-secondary'
        );
        expect(previewTextVariants({ variant: 'note' })).toBe(
            'text-caption leading-5 text-text-tertiary'
        );
    });
});
