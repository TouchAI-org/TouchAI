import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const markdownStyles = readFileSync(resolve('src/styles/markdown.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
);

// Assert the application stylesheet covers every light-DOM scroll owner used by
// the upgraded renderer. Actual scrolling/pseudo-element appearance needs a browser.
function ruleFor(selector: string) {
    const rule = Array.from(markdownStyles.matchAll(/([^{}]+)\{([^{}]*)\}/g)).find((match) =>
        match[1]!.split(',').some((part) => part.trim() === selector)
    );
    expect(rule, `Missing scrollbar rule: ${selector}`).toBeDefined();
    return rule![2]!.replace(/\s+/g, ' ');
}

describe('Markdown scrollbar stylesheet contract', () => {
    it.each([
        '.code-block-content',
        '.code-editor-container',
        '.stream-diffs-shell',
        '.code-pre-fallback',
    ])('keeps %s on the TouchAI scrollbar in every rendering phase', (owner) => {
        const selector = `.touchai-markdown ${owner}`;
        expect(ruleFor(selector)).toContain('scrollbar-width: auto;');
        expect(ruleFor(selector)).toContain('scrollbar-color: auto;');
        const scrollbar = ruleFor(`${selector}::-webkit-scrollbar`);
        expect(scrollbar).toContain('width: 6px;');
        expect(scrollbar).toContain('height: 6px;');
        expect(ruleFor(`${selector}::-webkit-scrollbar-track`)).toContain(
            'background: transparent;'
        );
        const thumb = ruleFor(`${selector}::-webkit-scrollbar-thumb`);
        expect(thumb).toContain('background: var(--color-scrollbar-thumb);');
        expect(thumb).toContain('border-radius: 3px;');
        expect(ruleFor(`${selector}::-webkit-scrollbar-thumb:hover`)).toContain(
            'background: var(--color-scrollbar-thumb-hover);'
        );
        expect(ruleFor(`${selector}::-webkit-scrollbar-button`)).toContain('display: none;');
    });

    it('keeps the horizontal bar in the constrained code viewport', () => {
        expect(markdownStyles).toMatch(
            /\.touchai-markdown\s+\.code-editor-container\s*\{\s*overflow:\s*auto !important;\s*\}/
        );
        expect(markdownStyles).toMatch(
            /\.touchai-markdown\s+\.stream-diffs-shell\s*\{\s*overflow:\s*visible !important;\s*\}/
        );

        const surfaceStyles = readFileSync(
            resolve('src/styles/markdown-code-surface.css'),
            'utf8'
        ).replace(/\/\*[\s\S]*?\*\//g, '');

        expect(surfaceStyles).toContain('overflow: visible !important;');
        expect(surfaceStyles).toContain('width: max-content;');
        expect(surfaceStyles).toContain('min-width: 100%;');
        expect(surfaceStyles).toMatch(
            /pre\[data-diff\]\[data-diff-type=(?:"split"|'split')\] \[data-code\]\s*\{[^}]*contain:\s*none !important;/
        );
    });
});
