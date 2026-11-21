import { cva } from 'class-variance-authority';

export const previewCardVariants = cva('', {
    variants: {
        variant: {
            scroll: 'rounded-lg border border-border-subtle bg-background-primary p-3 font-serif shadow-lg',
            reference: 'rounded-panel bg-surface-floating p-3 shadow-hover-preview',
            'reference-compact':
                'rounded-control border border-border bg-surface-floating px-2.5 py-2 font-serif shadow-preview-compact',
        },
    },
    defaultVariants: { variant: 'scroll' },
});

export const previewTextVariants = cva('', {
    variants: {
        variant: {
            title: 'text-compact font-medium text-text-primary',
            description: 'text-caption leading-5 text-text-secondary',
            note: 'text-caption leading-5 text-text-tertiary',
        },
    },
    defaultVariants: { variant: 'description' },
});
