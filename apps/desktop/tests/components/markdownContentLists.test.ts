import { mount } from '@vue/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * What a reader copies out of an answer has to paste into a plain-text editor and into a rich
 * editor equally well. These cover the shapes the first pass did not: ordered lists that start
 * somewhere other than one, reversed lists, per-item numbering, and the copy event arriving
 * without clipboard data.
 */

vi.mock('markdown-it-emoji', () => ({ full: {} }));

vi.mock('markstream-vue', () => ({
    default: {
        name: 'MarkdownRender',
        props: ['nodes'],
        template: '<div data-testid="markdown-render" />',
    },
    enableKatex: vi.fn(),
    enableMermaid: vi.fn(),
    getMarkdown: vi.fn(() => ({ use: vi.fn() })),
    languageMap: {},
    LinkNode: { name: 'LinkNode', template: '<a />' },
    parseMarkdownToStructure: vi.fn(() => []),
    setCustomComponents: vi.fn(),
    setDefaultI18nMap: vi.fn(),
}));

vi.mock('@services/NotificationService', () => ({ notify: vi.fn() }));

vi.mock('@/services/ClipboardService', () => ({
    clipboardService: { writeText: vi.fn() },
}));

/**
 * The component pulls in the markdown renderer, so it is imported once in `beforeAll` and only
 * mounted per test.
 */
let MarkdownContent: Awaited<typeof import('@components/MarkdownContent.vue')>['default'] | null =
    null;

beforeAll(async () => {
    const { setLocale } = await import('@/i18n');
    setLocale('en-US');
    MarkdownContent = (await import('@components/MarkdownContent.vue')).default;
});

async function mountContent(): Promise<{ element: HTMLElement; unmount: () => void }> {
    const wrapper = mount(MarkdownContent!, {
        props: { content: 'answer' },
        attachTo: document.body,
    });
    return { element: wrapper.element as HTMLElement, unmount: () => wrapper.unmount() };
}

function selectAll(container: HTMLElement, html: string): void {
    container.innerHTML = html;
    const range = document.createRange();
    range.selectNodeContents(container);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
}

function copy(container: HTMLElement): { html: string; text: string; prevented: boolean } {
    const data = new Map<string, string>();
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
        value: {
            setData: (type: string, value: string) => data.set(type, value),
            getData: (type: string) => data.get(type) ?? '',
        },
    });

    const prevented = !container.dispatchEvent(event);
    return { html: data.get('text/html') ?? '', text: data.get('text/plain') ?? '', prevented };
}

beforeEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
});

afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
});

describe('user copies a numbered list that does not start at one', () => {
    it('user gets a list numbered from its own starting number', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<ol start="5"><li>Five</li><li>Six</li></ol>');

        const copied = copy(wrapper.element);

        expect(copied.html).toContain('start="5"');
        expect(copied.text).toContain('5. Five');
        expect(copied.text).toContain('6. Six');

        wrapper.unmount();
    });

    it('user gets a reversed list counted down from its length', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<ol reversed><li>First</li><li>Second</li><li>Third</li></ol>');

        const copied = copy(wrapper.element);

        // Three items counted down: 3, 2, 1.
        expect(copied.text).toContain('3. First');
        expect(copied.text).toContain('2. Second');
        expect(copied.text).toContain('1. Third');

        wrapper.unmount();
    });

    it('user gets a reversed list that also declares a start counted down from there', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<ol reversed start="10"><li>Ten</li><li>Nine</li></ol>');

        const copied = copy(wrapper.element);

        expect(copied.text).toContain('10. Ten');
        expect(copied.text).toContain('9. Nine');

        wrapper.unmount();
    });

    it('user gets each item that carries its own number renumbered from there', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<ol><li>One</li><li value="7">Seven</li><li>Eight</li></ol>');

        const copied = copy(wrapper.element);

        // The explicit value resets the count for that item and everything after it.
        expect(copied.text).toContain('1. One');
        expect(copied.text).toContain('7. Seven');
        expect(copied.text).toContain('8. Eight');

        wrapper.unmount();
    });

    it('user gets a list type the browser cannot render dropped from the copied list', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<ol type="Q"><li>Item</li></ol>');

        const copied = copy(wrapper.element);

        expect(copied.html).not.toContain('type=');
        expect(copied.text).toContain('Item');

        wrapper.unmount();
    });

    it('user gets a roman-numeral list kept as roman numerals', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<ol type="I"><li>First</li></ol>');

        expect(copy(wrapper.element).html).toContain('type="I"');

        wrapper.unmount();
    });

    it('user gets a list item whose number is not a number left to the running count', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<ol><li>One</li><li value="abc">Two</li></ol>');

        const copied = copy(wrapper.element);

        // A malformed value must not produce "NaN." in the paste.
        expect(copied.text).not.toContain('NaN');
        expect(copied.text).toContain('2. Two');

        wrapper.unmount();
    });
});

describe('user copies a nested list that mixes numbered and bulleted items', () => {
    it('user gets a bulleted list nested in a numbered item kept in order', async () => {
        const wrapper = await mountContent();
        selectAll(
            wrapper.element,
            '<ol><li>Step one<ul><li>Detail A</li><li>Detail B</li></ul></li><li>Step two</li></ol>'
        );

        const copied = copy(wrapper.element);

        expect(copied.text).toContain('1. Step one');
        expect(copied.text).toContain('- Detail A');
        expect(copied.text).toContain('- Detail B');
        expect(copied.text).toContain('2. Step two');

        wrapper.unmount();
    });

    it('user gets an empty list item copied as its marker with nothing after it', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<ul><li>   </li></ul>');

        const copied = copy(wrapper.element);

        // The bullet survives so the structure is not silently lost, but no text comes with it.
        expect(copied.text).toBe('-');

        wrapper.unmount();
    });
});

describe('user copies prose that carries inline structure', () => {
    it('user gets a line break turned into a newline in the plain text', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<p>line one<br>line two</p>');

        const copied = copy(wrapper.element);

        expect(copied.text).toContain('line one\nline two');
        expect(copied.html).toContain('<br>');

        wrapper.unmount();
    });

    it('user gets a code block kept on its own lines in the plain text', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<p>before</p><pre>code line</pre><p>after</p>');

        const copied = copy(wrapper.element);

        expect(copied.text).toContain('code line');
        // The block has to be separated from the prose, not run into it.
        expect(copied.text).toMatch(/before\s*\n\s*code line/);

        wrapper.unmount();
    });

    it('user gets a table pasted as tab-separated rows in the plain text', async () => {
        const wrapper = await mountContent();
        selectAll(
            wrapper.element,
            '<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></tbody></table>'
        );

        const copied = copy(wrapper.element);

        expect(copied.text).toContain('A\tB');
        expect(copied.text).toContain('1\t2');

        wrapper.unmount();
    });

    it('user gets a table header cell kept as a header in the plain text', async () => {
        const wrapper = await mountContent();
        selectAll(
            wrapper.element,
            '<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Alice</td></tr></tbody></table>'
        );

        const copied = copy(wrapper.element);

        expect(copied.text).toContain('Name');
        expect(copied.text).toContain('Alice');

        wrapper.unmount();
    });

    it('user gets a link kept as text when the address is the same as the label', async () => {
        const wrapper = await mountContent();
        selectAll(
            wrapper.element,
            '<p><a href="https://example.com/">https://example.com/</a></p>'
        );

        const copied = copy(wrapper.element);

        // Repeating the address as a markdown link would be noise.
        expect(copied.text).not.toContain('](https://example.com/)');
        expect(copied.text).toContain('https://example.com/');

        wrapper.unmount();
    });

    it('user gets an image described by its alt text in the plain text', async () => {
        const wrapper = await mountContent();
        selectAll(
            wrapper.element,
            '<p>before <img src="https://example.com/a.png" alt="A chart"> after</p>'
        );

        expect(copy(wrapper.element).text).toContain('[A chart]');

        wrapper.unmount();
    });

    it('user gets an image with no alt text left out of the plain text', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<p>before <img src="https://example.com/a.png"> after</p>');

        const copied = copy(wrapper.element);

        expect(copied.text).toContain('before');
        expect(copied.text).toContain('after');
        expect(copied.text).not.toContain('[]');

        wrapper.unmount();
    });
});

describe('user copies when the browser gives no clipboard data', () => {
    it('user gets the browser default behaviour when the copy event carries no data', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<p>selected text</p>');

        // Some environments dispatch copy without clipboardData; touching it would throw.
        const event = new Event('copy', { bubbles: true, cancelable: true });
        const prevented = !wrapper.element.dispatchEvent(event);

        expect(prevented).toBe(false);

        wrapper.unmount();
    });

    it('user gets the browser default behaviour when nothing is selected', async () => {
        const wrapper = await mountContent();
        wrapper.element.innerHTML = '<p>text</p>';
        window.getSelection()!.removeAllRanges();

        const copied = copy(wrapper.element);

        expect(copied.prevented).toBe(false);
        expect(copied.html).toBe('');

        wrapper.unmount();
    });
});

describe('user copies from a table that the renderer wrapped in extra markup', () => {
    it('user gets the real table found through the wrapper the renderer adds', async () => {
        const wrapper = await mountContent();
        selectAll(
            wrapper.element,
            [
                '<div class="markdown-renderer">',
                '<div class="node-slot"><div class="node-content">',
                '<table><thead><tr><th>Item</th><th>Count</th></tr></thead>',
                '<tbody><tr><td>Apples</td><td>3</td></tr></tbody></table>',
                '</div></div></div>',
            ].join('')
        );

        const copied = copy(wrapper.element);

        // The wrapper nodes must not appear in the paste, only the table they hold.
        expect(copied.html).toContain('<table border="1"');
        expect(copied.text).toContain('Apples\t3');

        wrapper.unmount();
    });

    it('user gets only the part of a table that was selected', async () => {
        const wrapper = await mountContent();
        wrapper.element.innerHTML = [
            '<table><tbody>',
            '<tr><td>First row</td></tr>',
            '<tr><td>Second row</td></tr>',
            '<tr><td>Third row</td></tr>',
            '</tbody></table>',
        ].join('');

        // Select only the second row's cell.
        const cell = wrapper.element.querySelectorAll('td')[1]!;
        const range = document.createRange();
        range.selectNodeContents(cell);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        const copied = copy(wrapper.element);

        expect(copied.text).toContain('Second row');
        expect(copied.text).not.toContain('First row');
        expect(copied.text).not.toContain('Third row');

        wrapper.unmount();
    });
});

describe('user copies a table row that sits directly under the table', () => {
    it('user gets a row placed straight on the table kept in the paste', async () => {
        const wrapper = await mountContent();
        const container = wrapper.element;
        container.innerHTML = '';

        // A row appended through the DOM stays a direct child of the table; the HTML parser
        // would have wrapped it in a tbody.
        const table = document.createElement('table');
        const row = document.createElement('tr');
        const header = document.createElement('th');
        header.colSpan = 2;
        header.rowSpan = 2;
        header.textContent = 'Spanning header';
        row.append(header);
        const cell = document.createElement('td');
        cell.textContent = 'Plain cell';
        row.append(cell);
        table.append(row);
        container.append(table);

        const range = document.createRange();
        range.selectNodeContents(container);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        const copied = copy(container);

        expect(copied.html).toContain('Spanning header');
        expect(copied.html).toContain('colspan="2"');
        expect(copied.html).toContain('rowspan="2"');
        expect(copied.html).toContain('Plain cell');
        expect(copied.text).toContain('Spanning header\tPlain cell');

        wrapper.unmount();
    });
});

describe('user copies a list item that wraps its text in a paragraph', () => {
    it('user gets the paragraph inside a list item unwrapped so the bullet stays on one line', async () => {
        const wrapper = await mountContent();
        selectAll(
            wrapper.element,
            '<ul><li><p>First paragraph</p></li><li><p>Second paragraph</p></li></ul>'
        );

        const copied = copy(wrapper.element);

        // A <p> inside an <li> must not break the bullet away from its text.
        expect(copied.html).toContain('<li>First paragraph</li>');
        expect(copied.text).toContain('- First paragraph');
        expect(copied.text).toContain('- Second paragraph');

        wrapper.unmount();
    });

    it('user gets a nested wrapper div inside a list item unwrapped too', async () => {
        const wrapper = await mountContent();
        selectAll(
            wrapper.element,
            '<ul><li><div class="node-content"><span>Wrapped text</span></div></li></ul>'
        );

        const copied = copy(wrapper.element);

        expect(copied.text).toContain('- Wrapped text');

        wrapper.unmount();
    });
});

describe('user copies prose that contains comments the renderer left behind', () => {
    it('user gets the visible text without the comment markers', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<p>before<!-- hidden note -->after</p>');

        const copied = copy(wrapper.element);

        expect(copied.text).toContain('before');
        expect(copied.text).toContain('after');
        expect(copied.text).not.toContain('hidden note');

        wrapper.unmount();
    });
});

describe('user copies a list with a single item and no numbering', () => {
    it('user gets a one-item numbered list copied as number one', async () => {
        const wrapper = await mountContent();
        selectAll(wrapper.element, '<ol><li>Only item</li></ol>');

        expect(copy(wrapper.element).text).toContain('1. Only item');

        wrapper.unmount();
    });
});
