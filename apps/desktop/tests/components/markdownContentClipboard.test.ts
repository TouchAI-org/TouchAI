import { mount } from '@vue/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * What the user copies out of an answer is what they paste into their editor, so the shape of
 * the copied HTML and plain text is the contract: a table has to arrive as a table, a list has
 * to keep its numbering, and a link has to keep its address.
 *
 * The renderer is stubbed: this file is about the copy serializer, not about markstream. The
 * markup is put into the container directly, exactly as the renderer would leave it.
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
 * mounted per test. Importing it inside a test would spend that test's whole timeout on module
 * setup whenever the suite runs in parallel with other files.
 */
let MarkdownContent: Awaited<typeof import('@components/MarkdownContent.vue')>['default'] | null =
    null;

beforeAll(async () => {
    const { setLocale } = await import('@/i18n');
    setLocale('en-US');
    MarkdownContent = (await import('@components/MarkdownContent.vue')).default;
});

async function mountContent(content = 'answer'): Promise<{
    element: HTMLElement;
    unmount: () => void;
}> {
    const wrapper = mount(MarkdownContent!, { props: { content }, attachTo: document.body });
    return { element: wrapper.element as HTMLElement, unmount: () => wrapper.unmount() };
}

/** Puts the markup in the container and selects all of it, as a user dragging over it would. */
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

function copyHtmlOf(container: HTMLElement, html: string) {
    selectAll(container, html);
    return copy(container);
}

beforeEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
});

afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
});

describe('user copies a table out of an answer', () => {
    it('user gets the table as a real table with borders so it pastes as a table', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<table><thead><tr><th>Name</th><th>Age</th></tr></thead><tbody><tr><td>Alice</td><td>28</td></tr></tbody></table>'
        );

        expect(copied.html).toContain('<table border="1"');
        expect(copied.html).toContain('<thead>');
        expect(copied.html).toContain('<tbody>');
        expect(copied.html).toContain(
            '<th style="border: 1px solid #000; padding: 4px;">Name</th>'
        );
        expect(copied.html).toContain(
            '<td style="border: 1px solid #000; padding: 4px;">Alice</td>'
        );
        expect(copied.text).toBe('Name\tAge\nAlice\t28');

        wrapper.unmount();
    });

    it('user gets a merged cell kept merged in the copied table', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<table><tbody><tr><td colspan="2" rowspan="3">Merged</td><td>Plain</td></tr></tbody></table>'
        );

        expect(copied.html).toContain('colspan="2"');
        expect(copied.html).toContain('rowspan="3"');

        wrapper.unmount();
    });

    it('user gets a merged cell kept merged in a table with no row grouping', async () => {
        const wrapper = await mountContent();

        // A model-written table often has bare <tr> rows with no thead/tbody wrapper.
        const copied = copyHtmlOf(
            wrapper.element,
            '<table><tr><td colspan="2">Wide</td><td rowspan="2">Tall</td></tr><tr><td>B</td></tr></table>'
        );

        expect(copied.html).toContain('colspan="2"');
        expect(copied.html).toContain('rowspan="2"');
        // The text fallback keeps the rows on one line each, tabs between cells.
        expect(copied.text).toContain('Wide');
        expect(copied.text).toContain('\t');

        wrapper.unmount();
    });

    it('user gets a table footer kept in the copied table', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<table><thead><tr><th>Item</th></tr></thead><tbody><tr><td>A</td></tr></tbody><tfoot><tr><td>Total</td></tr></tfoot></table>'
        );

        expect(copied.html).toContain('<tfoot>');
        expect(copied.text).toContain('Total');

        wrapper.unmount();
    });

    it('user gets the table cells normalised so pasted rows stay on one line each', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<table><tbody><tr><td>  spread\n   over lines  </td><td>second</td></tr></tbody></table>'
        );

        expect(copied.text).toBe('spread over lines\tsecond');

        wrapper.unmount();
    });

    it('user gets an empty table pasted without a broken text block', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<table></table>');

        expect(copied.html).toContain('<table border="1"');
        expect(copied.text).toBe('');

        wrapper.unmount();
    });
});

describe('user copies a list out of an answer', () => {
    it('user gets the numbering kept when copying from the middle of a numbered list', async () => {
        const wrapper = await mountContent();
        const container = wrapper.element;
        container.innerHTML = '<ol><li>First</li><li>Second</li><li>Third</li></ol>';

        // Select the third item itself, the way a user drags over just that line.
        const third = container.querySelectorAll('li')[2]!;
        const range = document.createRange();
        range.selectNode(third);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        const copied = copy(container);

        // The pasted list has to start at 3, otherwise the copied line renumbers to 1.
        expect(copied.html).toContain('start="3"');
        expect(copied.text).toContain('3. Third');

        wrapper.unmount();
    });

    it('user gets a numbered list that starts at a custom number kept as it was', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<ol start="7"><li>Seven</li><li>Eight</li></ol>'
        );

        expect(copied.html).toContain('start="7"');
        expect(copied.text).toContain('7. Seven');

        wrapper.unmount();
    });

    it('user gets a reversed numbered list kept in reverse order', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<ol reversed><li>Three</li><li>Two</li><li>One</li></ol>'
        );

        expect(copied.html).toContain('reversed');
        expect(copied.text).toContain('3. Three');

        wrapper.unmount();
    });

    it('user gets a lettered numbered list kept as lettered', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<ol type="a"><li>Alpha</li><li>Beta</li></ol>');

        expect(copied.html).toContain('type="a"');
        expect(copied.text).toContain('1. Alpha');

        wrapper.unmount();
    });

    it('user gets a list type the browser does not know dropped instead of copied broken', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<ol type="Z"><li>Alpha</li></ol>');

        expect(copied.html).not.toContain('type=');
        expect(copied.html).toContain('Alpha');

        wrapper.unmount();
    });

    it('user gets an item that carries its own number kept at that number', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<ol><li>One</li><li value="10">Ten</li><li>Eleven</li></ol>'
        );

        expect(copied.html).toContain('value="10"');
        expect(copied.text).toContain('10. Ten');
        expect(copied.text).toContain('11. Eleven');

        wrapper.unmount();
    });

    it('user gets a bulleted list copied with dashes rather than numbers', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<ul><li>First</li><li>Second</li></ul>');

        expect(copied.html).toContain('<ul>');
        expect(copied.text).toBe('- First\n- Second');

        wrapper.unmount();
    });

    it('user gets a nested list kept inside its parent item', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<ul><li>Parent<ul><li>Child</li></ul></li></ul>'
        );

        expect(copied.html).toContain('Parent');
        expect(copied.html).toContain('Child');
        expect(copied.text).toContain('- Parent');
        expect(copied.text).toContain('- Child');

        wrapper.unmount();
    });
});

describe('user copies links and images out of an answer', () => {
    it('user gets a link copied with its address so it stays clickable', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<p>Read <a href="https://example.com/docs">the docs</a></p>'
        );

        expect(copied.html).toContain('href="https://example.com/docs"');
        expect(copied.text).toContain('[the docs](https://example.com/docs)');

        wrapper.unmount();
    });

    it('user gets a link title kept with the copied link', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<p><a href="https://example.com" title="Example home">Example</a></p>'
        );

        expect(copied.html).toContain('title="Example home"');

        wrapper.unmount();
    });

    it('user gets an in-page anchor link kept as an anchor', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<p><a href="#section">Jump</a></p>');

        expect(copied.html).toContain('href="#section"');

        wrapper.unmount();
    });

    it('user does not get a script link copied into their document', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<p><a href="javascript:alert(1)">Click me</a></p>'
        );

        expect(copied.html).not.toContain('javascript:');
        expect(copied.html).toContain('Click me');

        wrapper.unmount();
    });

    it('user does not get a link with an empty address copied as a link', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<p><a href="   ">Empty</a></p>');

        expect(copied.html).not.toContain('href=');
        expect(copied.html).toContain('Empty');

        wrapper.unmount();
    });

    it('user gets an image copied with its address, alt text and title', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<p><img src="https://example.com/chart.png" alt="Revenue chart" title="Q3 revenue"></p>'
        );

        expect(copied.html).toContain('src="https://example.com/chart.png"');
        expect(copied.html).toContain('alt="Revenue chart"');
        expect(copied.html).toContain('title="Q3 revenue"');

        wrapper.unmount();
    });

    it('user gets an image without alt text copied as just the image', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<p><img src="https://example.com/a.png"></p>');

        expect(copied.html).toContain('src="https://example.com/a.png"');
        expect(copied.html).not.toContain('alt=');

        wrapper.unmount();
    });

    it('user does not get an image with a script source copied', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<p><img src="javascript:alert(1)"></p>');

        expect(copied.html).not.toContain('javascript:');

        wrapper.unmount();
    });

    it('user gets the image alt text in the plain-text copy so the picture is not lost', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<p>Before <img src="https://example.com/chart.png" alt="Revenue chart"> after</p>'
        );

        expect(copied.text).toContain('[Revenue chart]');

        wrapper.unmount();
    });
});

describe('user copies formatted prose out of an answer', () => {
    it('user gets line breaks kept as breaks instead of running the lines together', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<p>line one<br>line two</p>');

        expect(copied.html).toContain('<br>');
        expect(copied.text).toContain('line one\nline two');

        wrapper.unmount();
    });

    it('user gets a horizontal rule kept in the copied HTML', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<div>above<hr>below</div>');

        expect(copied.html).toContain('<hr>');

        wrapper.unmount();
    });

    it('user gets a code block copied as pre and code rather than losing its shape', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(wrapper.element, '<pre><code>const value = 1;</code></pre>');

        expect(copied.html).toContain('<pre><code>const value = 1;</code></pre>');
        expect(copied.text).toContain('const value = 1;');

        wrapper.unmount();
    });

    it('user gets code containing angle brackets escaped so it cannot inject markup', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<pre><code>&lt;div class="x"&gt;&lt;/div&gt;</code></pre>'
        );

        expect(copied.html).toContain('&lt;div class=&quot;x&quot;&gt;');

        wrapper.unmount();
    });

    it('user does not get a hidden block copied into their document', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            [
                '<p>Visible</p>',
                '<div style="display: none">display secret</div>',
                '<div style="visibility:hidden">visibility secret</div>',
                '<div style="opacity:0">opacity secret</div>',
                '<div hidden>hidden secret</div>',
                '<div aria-hidden="true">aria secret</div>',
            ].join('')
        );

        expect(copied.text).toBe('Visible');
        expect(copied.html).not.toContain('secret');

        wrapper.unmount();
    });

    it('user does not get a script or style block copied into their document', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<p>Text</p><script>alert(1)</script><style>.x{color:red}</style>'
        );

        expect(copied.html).not.toContain('alert(1)');
        expect(copied.html).not.toContain('color:red');
        expect(copied.html).toContain('Text');

        wrapper.unmount();
    });

    it('user gets the text spacing preserved around inline formatting', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<p>Keep <strong>this</strong> and <em>that</em> together</p>'
        );

        expect(copied.text).toBe('Keep this and that together');
        expect(copied.html).toContain('<strong>this</strong>');
        expect(copied.html).toContain('<em>that</em>');

        wrapper.unmount();
    });

    it('user gets a link copied as markdown in the plain text with its destination escaped', async () => {
        const wrapper = await mountContent();

        const copied = copyHtmlOf(
            wrapper.element,
            '<p><a href="https://example.com/a_(b)">paren link</a></p>'
        );

        // A raw closing parenthesis would end the markdown destination early.
        expect(copied.text).toContain('https://example.com/a_(b\\)');

        wrapper.unmount();
    });
});

describe('user copies from a partly selected answer', () => {
    it('user gets only the selected part when they drag over one paragraph', async () => {
        const wrapper = await mountContent();
        const container = wrapper.element;
        container.innerHTML = '<p>first paragraph</p><p>second paragraph</p>';

        const range = document.createRange();
        range.selectNodeContents(container.querySelectorAll('p')[1]!);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        const copied = copy(container);

        expect(copied.text).toBe('second paragraph');
        expect(copied.text).not.toContain('first paragraph');

        wrapper.unmount();
    });

    it('user gets the browser copy left alone when their selection is outside the answer', async () => {
        const wrapper = await mountContent();
        const container = wrapper.element;
        container.innerHTML = '<p>answer</p>';

        const outside = document.createElement('p');
        outside.textContent = 'somewhere else';
        document.body.append(outside);

        const range = document.createRange();
        range.selectNodeContents(outside);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        const copied = copy(container);

        expect(copied.prevented).toBe(false);
        expect(copied.html).toBe('');

        wrapper.unmount();
    });

    it('user gets the browser copy left alone when the selection is collapsed to a caret', async () => {
        const wrapper = await mountContent();
        const container = wrapper.element;
        container.innerHTML = '<p>answer</p>';

        const range = document.createRange();
        range.setStart(container.querySelector('p')!.firstChild!, 2);
        range.collapse(true);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        const copied = copy(container);

        expect(copied.prevented).toBe(false);

        wrapper.unmount();
    });
});
