import { describe, expect, it } from 'vitest';

import { hasMathDelimiterOutsideCode } from '@/utils/markdownMathDetection';

describe('hasMathDelimiterOutsideCode', () => {
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
    ])('detects delimiters correctly for %s', (_name, markdown, expected) => {
        expect(hasMathDelimiterOutsideCode(markdown)).toBe(expected);
    });
});
