import { describe, expect, it } from 'vitest';

import {
    hasMathDelimiterOutsideCode,
    hasUnclosedMathDelimiterOutsideCode,
    mayContainMathDelimiter,
} from '@/utils/markdownMathDetection';

describe('hasUnclosedMathDelimiterOutsideCode', () => {
    it.each([
        ['closed block math', '$$x^2$$', false],
        ['two closed block formulas', '$$a$$ text $$b$$', false],
        ['unclosed block math at end', 'intro\n$$\nx^2', true],
        ['closed bracket math', String.raw`\[x\]`, false],
        ['unclosed bracket math', String.raw`\[x`, true],
        ['markers only inside code fences', '```sh\necho $$\n```', false],
        ['closed block followed by unclosed inline', String.raw`$$a$$ then \[b`, true],
        ['no math at all', 'plain text with `code` and $5', false],
    ])('reports unclosed state for %s', (_name, markdown, expected) => {
        expect(hasUnclosedMathDelimiterOutsideCode(markdown)).toBe(expected);
    });

    it('never reports unclosed for input the full scan does not treat as math', () => {
        for (const markdown of ['plain', '`$$` code', '```\n\\[x\\]\n```']) {
            if (!hasMathDelimiterOutsideCode(markdown)) {
                expect(hasUnclosedMathDelimiterOutsideCode(markdown)).toBe(false);
            }
        }
    });
});

describe('mayContainMathDelimiter', () => {
    it.each([
        ['plain prose', 'A long ordinary paragraph without any dollar signs.', false],
        ['backticks only', 'Inline `code` and ``more`` spans.', false],
        ['a single dollar', 'Cost is $5 and that is final.', false],
        ['escaped dollar bracket', String.raw`Escaped \$[not math] here.`, false],
        ['block math candidate', 'Text $$x$$ text', true],
        ['bracket candidate', String.raw`Text \[x\] text`, true],
        ['candidate inside a fence', '```sh\necho $$\n```', true],
    ])('reports whether %s can contain math delimiters', (_name, markdown, expected) => {
        expect(mayContainMathDelimiter(markdown)).toBe(expected);
    });

    it('never rejects input that the full scan would accept', () => {
        const cases = [
            'Text $$x$$',
            String.raw`Text \[x\]`,
            '```sh\necho $$\n```\n\n$$\nx^2\n$$',
            'Inline `$$`, followed by \\[\nx^2\n\\]',
            'Unmatched ` marker, then $$',
        ];

        for (const markdown of cases) {
            if (hasMathDelimiterOutsideCode(markdown)) {
                expect(mayContainMathDelimiter(markdown)).toBe(true);
            }
        }
    });
});

describe('user writes math next to code', () => {
    it.each([
        ['fenced shell markers', '```sh\necho $$ and \\[\n```', false],
        ['fenced markers with a longer closer', '~~~js\nconst marker = "$$ \\[";\n~~~~', false],
        ['inline code markers', 'Inline `$$` and `\\[` markers.', false],
        [
            'escaped backticks do not hide math',
            String.raw`\` literal, then $$, then \` literal.`,
            true,
        ],
        ['multiline inline code markers', 'Text `code\n$$ and \\[\nspan` after.', false],
        [
            'code spans can contain other backtick runs',
            'Outer `span `` marker` and then ``$$``',
            false,
        ],
        ['math after fenced markers', '```sh\necho $$\n```\n\n$$\nx^2\n$$', true],
        ['math after inline markers', 'Inline `$$`, followed by \\[\nx^2\n\\]', true],
        ['math after an unmatched backtick', 'Unmatched ` marker, then $$', true],
        ['ordinary math delimiters', String.raw`$$x^2$$ and \[x\]`, true],
    ])('user detects delimiters correctly for %s', (_name, markdown, expected) => {
        expect(hasMathDelimiterOutsideCode(markdown)).toBe(expected);
    });
});
