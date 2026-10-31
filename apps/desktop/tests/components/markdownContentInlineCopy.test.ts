import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clipboardService } from '@/services/ClipboardService';

/*
 * MarkdownContent-i18n covers the rendering, the parser options and the clipboard
 * serialization. This file covers the one interaction a reader performs directly on
 * the rendered answer: clicking inline code copies it, but a fenced block must not be
 * copied twice, and a refused copy has to tell the user instead of failing silently.
 */

const { notifyMock, parseMarkdownToStructureMock, setDefaultI18nMapMock } = vi.hoisted(() => ({
    notifyMock: vi.fn(),
    parseMarkdownToStructureMock: vi.fn(() => []),
    setDefaultI18nMapMock: vi.fn(),
}));

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
    parseMarkdownToStructure: parseMarkdownToStructureMock,
    setCustomComponents: vi.fn(),
    setDefaultI18nMap: setDefaultI18nMapMock,
}));

vi.mock('@services/NotificationService', () => ({ notify: notifyMock }));

vi.mock('@/services/ClipboardService', () => ({
    clipboardService: { writeText: vi.fn() },
}));

async function mountContent(content = '`pnpm test`') {
    const { setLocale } = await import('@/i18n');
    setLocale('zh-CN');
    const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
    return mount(MarkdownContent, {
        props: { content },
        attachTo: document.body,
    });
}

/** Add a rendered code element inside the markdown container, as the renderer would. */
function appendCode(
    wrapper: Awaited<ReturnType<typeof mountContent>>,
    text: string,
    parentTag = 'p'
): HTMLElement {
    const container = wrapper.element as HTMLElement;
    const parent = document.createElement(parentTag);
    const code = document.createElement('code');
    code.textContent = text;
    parent.append(code);
    container.append(parent);
    return code;
}

async function click(element: HTMLElement) {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    vi.mocked(clipboardService.writeText).mockResolvedValue(undefined);
});

describe('user copies a piece of inline code by clicking it', () => {
    it('user gets the inline code copied and told it worked', async () => {
        const wrapper = await mountContent();

        await click(appendCode(wrapper, 'pnpm test'));

        expect(clipboardService.writeText).toHaveBeenCalledWith('pnpm test');
        expect(notifyMock).toHaveBeenCalledWith({ title: 'TouchAI', body: '已复制' });
    });

    it('user gets the code copied without its surrounding whitespace', async () => {
        const wrapper = await mountContent();

        await click(appendCode(wrapper, '  npm run build  '));

        expect(clipboardService.writeText).toHaveBeenCalledWith('npm run build');
    });

    it('user is told the copy failed when the clipboard refuses', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(clipboardService.writeText).mockRejectedValue(new Error('clipboard denied'));
        const wrapper = await mountContent();

        await click(appendCode(wrapper, 'pnpm test'));

        expect(notifyMock).toHaveBeenCalledWith({ title: 'TouchAI', body: '复制失败' });
        consoleError.mockRestore();
    });

    it('user gets nothing copied when the code block has no text', async () => {
        const wrapper = await mountContent();

        await click(appendCode(wrapper, '   '));

        expect(clipboardService.writeText).not.toHaveBeenCalled();
    });

    it('user does not get a fenced block copied on click, because its own header has a copy action', async () => {
        const wrapper = await mountContent();

        await click(appendCode(wrapper, 'const value = 1;', 'pre'));

        expect(clipboardService.writeText).not.toHaveBeenCalled();
    });

    it('user does not get a code block copied on click inside the block wrapper', async () => {
        const wrapper = await mountContent([].join(''));

        const wrapperDiv = document.createElement('div');
        wrapperDiv.className = 'code-block-container';
        const code = document.createElement('code');
        code.textContent = 'const value = 1;';
        wrapperDiv.append(code);
        (wrapper.element as HTMLElement).append(wrapperDiv);

        await click(code);

        expect(clipboardService.writeText).not.toHaveBeenCalled();
    });

    it('user clicking plain prose is not treated as a copy request', async () => {
        const wrapper = await mountContent();

        const paragraph = document.createElement('p');
        paragraph.textContent = 'Just some prose';
        (wrapper.element as HTMLElement).append(paragraph);
        await click(paragraph);

        expect(clipboardService.writeText).not.toHaveBeenCalled();
        expect(notifyMock).not.toHaveBeenCalled();
    });
});

describe('user copies a selection out of the answer', () => {
    function copySelection(container: Element): { html: string; text: string; prevented: boolean } {
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

    it('user gets the selected words as both rich and plain clipboard content', async () => {
        const wrapper = await mountContent();
        const container = wrapper.element as HTMLElement;
        container.innerHTML = '<p>Keep <strong>this</strong> sentence</p>';

        const range = document.createRange();
        range.selectNodeContents(container);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        const copied = copySelection(container);

        expect(copied.prevented).toBe(true);
        expect(copied.text).toContain('Keep this sentence');
        expect(copied.html).toContain('<strong>');
        selection.removeAllRanges();
    });

    it('user gets the browser’s own behaviour when nothing is selected', async () => {
        const wrapper = await mountContent();
        const container = wrapper.element as HTMLElement;
        window.getSelection()!.removeAllRanges();

        const copied = copySelection(container);

        expect(copied.prevented).toBe(false);
        expect(copied.html).toBe('');
    });
});
