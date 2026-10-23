import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { previewNotificationText, summarizeNotificationText } from '@/utils/reminderText';

describe('user previews a reminder', () => {
    beforeEach(() => {
        setLocale('en-US');
    });

    it.each([
        [
            '# Done\n- Fixed **alerts**\n- Read [docs](https://example.com)',
            'Done; Fixed alerts; Read docs',
        ],
        ['> First\n\nSecond\n\n1. Third', 'First; Second; Third'],
        ['See [**docs**][ref]\n\n[ref]: https://example.com', 'See docs'],
        ['See [docs][]\n\n[docs]: https://example.com', 'See docs'],
        ['See [docs]\n\n[docs]: https://example.com', 'See docs'],
        ['See ![build **result**](image.png)', 'See build result'],
        ['See [open `]` `src/__tests__/file.ts`](target)', 'See open ] src/__tests__/file.ts'],
        [
            'Use `C:\\__tests__\\file.ts` and `packages/**/src`',
            'Use C:\\__tests__\\file.ts and packages/**/src',
        ],
        ['```text\nC:\\__tests__\\file.ts\necho <tag>\n```', 'C:\\__tests__\\file.ts echo <tag>'],
        ['Hello &amp; goodbye', 'Hello & goodbye'],
        ['\\#\\# \\*\\*literal\\*\\*', '## **literal**'],
        ['<div>First</div><script>literal</script>', '<div>First</div><script>literal</script>'],
        ['First\nSecond  \nThird', 'First; Second; Third'],
        ['| Step | Result |\n| --- | --- |\n| lint | **passed** |', 'Step, Result; lint, passed'],
    ])('user extracts a standard Markdown preview from %j', (source, expected) => {
        expect(summarizeNotificationText(source)).toBe(expected);
    });

    it('user keeps repeated paragraphs instead of guessing whether they are duplicates', () => {
        expect(summarizeNotificationText('First\n\nFirst\n\nLast')).toBe('First; First; Last');
    });

    it('user limits completion summaries to four nonempty clauses', () => {
        expect(
            summarizeNotificationText('# Done\n- One\n- Two\n- Three\n- Four', 220, 'summary')
        ).toBe('Done; One; Two; Three');
    });

    it('user uses one Chinese separator for paragraphs and a list separator for table cells', () => {
        setLocale('zh-CN');
        expect(
            summarizeNotificationText('# 完成\n- 类型检查通过\n- 测试通过', 220, 'summary')
        ).toBe('完成；类型检查通过；测试通过');
        expect(summarizeNotificationText('| 步骤 | 结果 |\n| --- | --- |\n| 测试 | 通过 |')).toBe(
            '步骤、结果；测试、通过'
        );
    });

    it('user gets null for empty Markdown', () => {
        expect(summarizeNotificationText(null)).toBeNull();
        expect(summarizeNotificationText('  \n\n')).toBeNull();
        expect(summarizeNotificationText('# ')).toBeNull();
    });

    it('user does not split an emoji at the source scan boundary', () => {
        expect(summarizeNotificationText(' '.repeat(4095) + '😀tail')).toBeNull();
    });
});

describe('user previews a plain reminder', () => {
    it.each([
        'Expected <T extends U> but received <T extends V>',
        '[ERROR]: C:\\Users\\admin\\__tests__\\file.ts',
        'Use /tmp/项目/__tests__/file.ts and src/{foo,bar}_*.ts',
        'cat <<EOF>out.txt echo “<tag>” >out.txt',
        '**literal** [logs](https://example.com) &amp; <script>text</script>',
    ])('user preserves literal syntax in %j', (source) => {
        expect(previewNotificationText(source)).toBe(source);
    });

    it('user only collapses whitespace', () => {
        expect(previewNotificationText('  first\r\n\tsecond  ')).toBe('first second');
    });

    it.each([undefined, null, '', ' \n\t '])('user gets null for %j', (source) => {
        expect(previewNotificationText(source)).toBeNull();
    });
});

describe.each([
    ['Markdown', summarizeNotificationText],
    ['literal', previewNotificationText],
] as const)('%s preview length budgets', (_name, preview) => {
    it('user includes the ellipsis in the default 220-character budget', () => {
        const result = preview('a'.repeat(300));
        expect(result).toBe('a'.repeat(217) + '...');
        expect(result?.length).toBe(220);
    });

    it('user does not split an emoji at the output boundary', () => {
        expect(preview('a'.repeat(216) + '😀tail')).toBe('a'.repeat(216) + '...');
        expect(preview('😀tail', 5)).toBe('😀...');
    });

    it.each([0, 1, 2, 3, 4, 6])('user honors a small %i-character budget', (budget) => {
        expect(preview('long content', budget)?.length).toBeLessThanOrEqual(budget);
    });
});
