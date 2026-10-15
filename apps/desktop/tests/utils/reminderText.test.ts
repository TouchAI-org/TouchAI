import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { summarizeNotificationText } from '@/utils/reminderText';

describe('reminder text conversion', () => {
    beforeEach(() => {
        setLocale('en-US');
    });

    it.each([
        ['See [open `]` src/__tests__/file.ts](target)', 'See open ] src/__tests__/file.ts'],
        ['See ![open `]` src/__tests__/file.ts](image.png)', 'See open ] src/__tests__/file.ts'],
        ['See [open \\] src/__tests__/file.ts](target)', 'See open ] src/__tests__/file.ts'],
        ['See ![open \\] src/__tests__/file.ts](image.png)', 'See open ] src/__tests__/file.ts'],
        ['See:[open src/__tests__/file.ts](target)', 'See:open src/__tests__/file.ts'],
        ['See:![open src/__tests__/file.ts](image.png)', 'See:open src/__tests__/file.ts'],
    ])('preserves paths and delimiters in link labels %j', (source, expected) => {
        expect(summarizeNotificationText(source)).toBe(expected);
    });

    it.each([
        [
            '| A | B |\n| --- | --- |\n| Keep | Before<script>hidden |\n\nend</script> After\n\nTail',
            'A, B; Keep, Before After; Tail',
        ],
        ['See [open src/__tests__/file.ts](target)', 'See open src/__tests__/file.ts'],
        ['See ![open src/__tests__/file.ts](image.png)', 'See open src/__tests__/file.ts'],
    ])('preserves follow-up review input %j', (source, expected) => {
        expect(summarizeNotificationText(source)).toBe(expected);
    });

    it.each([
        ['Fail <script>one\n\ntwo</script> done', 'Fail done'],
        ['Fail <style>one\n\ntwo</style> done', 'Fail done'],
        ['Before\n\nFail<script>one\n\ntwo</script> done\n\nAfter', 'Before; Fail done; After'],
        [
            'Use `<script>` literally\n\nVisible\n\nUse `</script>` literally',
            'Use <script> literally; Visible; Use </script> literally',
        ],
        ['Fail<script>one\n\n`code`\n\ntwo</script> done', 'Fail done'],
        ['See [src/__tests__/file.ts](src/__tests__/file.ts)', 'See src/__tests__/file.ts'],
        ['See ![src/__tests__/file.ts](image.png)', 'See src/__tests__/file.ts'],
        [
            'See [src/__tests__/file.ts][ref]\n\n[ref]: https://example.com',
            'See src/__tests__/file.ts',
        ],
        [
            'Cannot open <C:\\Users\\admin\\__tests__\\file.ts>',
            'Cannot open <C:\\Users\\admin\\__tests__\\file.ts>',
        ],
        ['Cannot open <src/__tests__/file.ts>', 'Cannot open <src/__tests__/file.ts>'],
        ['\\#\\# One\n\\#\\# Two', 'One; Two'],
        ['`literal\n\\#\\# code`', 'literal \\#\\# code'],
    ])('preserves reviewed input %j', (source, expected) => {
        expect(summarizeNotificationText(source)).toBe(expected);
    });

    it('does not split an emoji at the source scan boundary', () => {
        expect(summarizeNotificationText(' '.repeat(4095) + '😀tail')).toBeNull();
    });

    it.each([
        [
            '| Diagnostic |\n| --- |\n| [ERROR]: /tmp/项目/__tests__/file.ts |',
            'Diagnostic; [ERROR]: /tmp/项目/__tests__/file.ts',
        ],
        [
            '| Diagnostic |\n| --- |\n| <div>C:\\__tests__\\file.ts</div> |',
            'Diagnostic; C:\\__tests__\\file.ts',
        ],
        [
            'See [docs][ref] and src/__tests__/file.ts\n\n[ref]: https://example.com',
            'See docs and src/__tests__/file.ts',
        ],
        [
            'See [docs][ref] in src/__tests__/one.ts\n\nUse [docs][ref] in src/__tests__/two.ts\n\n[ref]: https://example.com',
            'See docs in src/__tests__/one.ts; Use docs in src/__tests__/two.ts',
        ],
        [
            'See [docs][] in src/__tests__/file.ts\n\n[docs]: https://example.com',
            'See docs in src/__tests__/file.ts',
        ],
        [
            'See [docs] in src/__tests__/file.ts\n\n[docs]: https://example.com',
            'See docs in src/__tests__/file.ts',
        ],
        ['Use *_test/*.ts*', 'Use *_test/*.ts*'],
        [
            '| Delimiter | Path | End |\n| --- | --- | --- |\n| ` | /tmp/项目/__tests__/file.ts | ` |',
            'Delimiter, Path, End; `, /tmp/项目/__tests__/file.ts, `',
        ],
        [
            '| Start | Value |\n| --- | --- |\n| ` | one |\n| /tmp/项目/__tests__/file.ts | two |\n| ` | end |',
            'Start, Value; `, one; /tmp/项目/__tests__/file.ts, two; `, end',
        ],
        ['Use __tests__/__fixtures__', 'Use __tests__/__fixtures__'],
        [
            'Use src/{foo,bar}_*.ts and test/{foo,bar}_*.ts',
            'Use src/{foo,bar}_*.ts and test/{foo,bar}_*.ts',
        ],
        [
            'Use ` as a delimiter.\n\nChanged /tmp/项目/__tests__/file.ts.\n\nEscape ` when needed.',
            'Use ` as a delimiter. Changed /tmp/项目/__tests__/file.ts. Escape ` when needed.',
        ],
        [
            '- Use ` as a delimiter\n- Changed /tmp/项目/__tests__/file.ts\n- Escape ` when needed',
            'Use ` as a delimiter; Changed /tmp/项目/__tests__/file.ts; Escape ` when needed',
        ],
        ['Failure: <span>C:\\__tests__\\file.ts</span>', 'Failure: C:\\__tests__\\file.ts'],
        [
            'Failure: <span title="`">C:\\__tests__\\file.ts</span> and `literal`',
            'Failure: C:\\__tests__\\file.ts and literal',
        ],
        ['``C:\\__tests__\\file.ts `literal` ``', 'C:\\__tests__\\file.ts `literal`'],
        ['`C:\\__tests__\\file.ts\nnext`', 'C:\\__tests__\\file.ts next'],
        ['**src/my_file_*.ts** and *src/other_file.ts*', 'src/my_file_*.ts and src/other_file.ts'],
        ['Use src/[ab]_*.ts and src/{foo,bar}_*.ts', 'Use src/[ab]_*.ts and src/{foo,bar}_*.ts'],
        ['before `unmatched and src/my_file_*.ts', 'before `unmatched and src/my_file_*.ts'],
        ['Failure: <img src="hidden.png">details', 'Failure: details'],
        ['Failure: <custom-element role="note">details</custom-element>', 'Failure: details'],
        ['`C:\\__tests__\\file.ts`', 'C:\\__tests__\\file.ts'],
        ['expected <img> to equal <input>', 'expected <img> to equal <input>'],
        [
            'Expected <T extends U> but received <T extends V>',
            'Expected <T extends U> but received <T extends V>',
        ],
        ['Use /tmp/项目/__tests__/file.ts', 'Use /tmp/项目/__tests__/file.ts'],
        [
            'Use src/my_file_*.ts and src/other_file_*.ts',
            'Use src/my_file_*.ts and src/other_file_*.ts',
        ],
        ['Use `<script>alert(1)</script>` literally', 'Use <script>alert(1)</script> literally'],
        ['```html\n<script>alert(1)</script>\n```', '<script>alert(1)</script>'],
        ['<title> was expected, but <h1> was found', '<title> was expected, but <h1> was found'],
        ['<div>First step</div><div>Second step</div>', 'First step; Second step'],
        ['Failure: <span title="a > b">details</span>', 'Failure: details'],
        ['Failure<script data-x=">">hidden</script>See logs', 'Failure See logs'],
        ['<div>Path C:\\__tests__\\file.ts &amp; logs</div>', 'Path C:\\__tests__\\file.ts & logs'],
        ['<div><!--hidden--><b>Details</b><script>hidden</script></div>', 'Details'],
        ['```text\nC:\\__tests__\\file.ts\n```', 'C:\\__tests__\\file.ts'],
        ['See ![build result](https://example.com/status.png)', 'See build result'],
        [
            '%%TOUCHAI_REMINDER_PATH_0%% src/my_file.ts',
            '%%TOUCHAI_REMINDER_PATH_0%% src/my_file.ts',
        ],
    ])('converts %j without losing visible information', (source, expected) => {
        expect(summarizeNotificationText(source)).toBe(expected);
    });

    it('does not emit an unpaired surrogate when truncating emoji', () => {
        const result = summarizeNotificationText('a'.repeat(216) + '😀tail');
        expect(result).toBe('a'.repeat(216) + '...');
        expect(result?.length).toBeLessThanOrEqual(220);
    });

    it.each([0, 1, 2, 3, 4, 6])('honors a small %i-character budget', (budget) => {
        expect(summarizeNotificationText('long content', budget)?.length).toBeLessThanOrEqual(
            budget
        );
    });

    it('does not restore raw markup when all visible content was removed', () => {
        expect(summarizeNotificationText('<script>hidden</script>')).toBeNull();
        expect(summarizeNotificationText('<span></span>')).toBeNull();
    });

    it('limits completion summaries to four nonempty clauses', () => {
        expect(
            summarizeNotificationText('# Done\n- One\n- Two\n- Three\n- Four', 220, 'summary')
        ).toBe('Done: One, Two, Three');
    });

    it('uses Chinese punctuation in Chinese summaries', () => {
        setLocale('zh-CN');
        expect(
            summarizeNotificationText('# 完成\n- 类型检查通过\n- 测试通过', 220, 'summary')
        ).toBe('完成：类型检查通过、测试通过');
    });

    it('preserves literal diagnostics without DOMParser', () => {
        vi.stubGlobal('DOMParser', undefined);
        try {
            expect(summarizeNotificationText('<title> was expected, but <h1> was found')).toBe(
                '<title> was expected, but <h1> was found'
            );
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
