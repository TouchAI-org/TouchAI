import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { clipboardService } from '@/services/ClipboardService';

const {
    getMarkdownMock,
    languageMapMock,
    markdownRenderUnmountedMock,
    notifyMock,
    parseMarkdownToStructureMock,
    setDefaultI18nMapMock,
} = vi.hoisted(() => {
    type MarkdownNodeFixture = {
        type: string;
        label?: string;
    };

    return {
        getMarkdownMock: vi.fn(() => ({
            use: vi.fn(),
        })),
        languageMapMock: {} as Record<string, string>,
        markdownRenderUnmountedMock: vi.fn(),
        notifyMock: vi.fn(),
        parseMarkdownToStructureMock: vi.fn<() => MarkdownNodeFixture[]>(() => []),
        setDefaultI18nMapMock: vi.fn(),
    };
});

vi.mock('markdown-it-emoji', () => ({
    full: {},
}));

vi.mock('markstream-vue', () => ({
    default: {
        name: 'MarkdownRender',
        props: ['nodes', 'codeBlockMonacoOptions'],
        unmounted() {
            markdownRenderUnmountedMock();
        },
        template:
            '<div data-testid="markdown-render" :data-code-block-auto-scroll-initial="String(codeBlockMonacoOptions?.autoScrollInitial)">{{ nodes?.[0]?.label ?? "" }}</div>',
    },
    enableKatex: vi.fn(),
    enableMermaid: vi.fn(),
    getMarkdown: getMarkdownMock,
    languageMap: languageMapMock,
    parseMarkdownToStructure: parseMarkdownToStructureMock,
    setDefaultI18nMap: setDefaultI18nMapMock,
}));

vi.mock('@services/NotificationService', () => ({
    notify: notifyMock,
}));

vi.mock('@/services/ClipboardService', () => ({
    clipboardService: {
        writeText: vi.fn(),
    },
}));

class ClipboardDataStub {
    private readonly data = new Map<string, string>();

    setData(type: string, value: string) {
        this.data.set(type, value);
    }

    getData(type: string) {
        return this.data.get(type) ?? '';
    }
}

describe('MarkdownContent i18n', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        for (const key of Object.keys(languageMapMock)) {
            delete languageMapMock[key];
        }
        vi.resetModules();
        const { setLocale } = await import('@/i18n');
        setLocale('zh-CN');
    });

    it('configures markstream labels for English locale', async () => {
        const { setLocale } = await import('@/i18n');
        setLocale('en-US');
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        mount(MarkdownContent, {
            props: {
                content: '```ts\nconsole.log(1)\n```',
            },
        });

        expect(setDefaultI18nMapMock).toHaveBeenCalledWith(
            expect.objectContaining({
                'common.copy': 'Copy',
                'common.copySuccess': 'Copied',
                'image.loading': 'Loading image...',
            })
        );
        expect(languageMapMock.plaintext).toBe('Plain text');
        expect(languageMapMock.mermaid).toBe('Diagram');
    });

    it('escapes shell variables so KaTeX does not treat them as inline math', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        mount(MarkdownContent, {
            props: {
                content:
                    'paths: $env:USERPROFILE\\Desktop, $HOME/project, ${USERPROFILE}\\Desktop, ${env:APPDATA}; math: $x$ and $x+y$; code: `echo $HOME`',
            },
        });

        expect(parseMarkdownToStructureMock).toHaveBeenCalledWith(
            'paths: \\$env:USERPROFILE\\Desktop, \\$HOME/project, \\${USERPROFILE}\\Desktop, \\${env:APPDATA}; math: $x$ and $x+y$; code: `echo $HOME`',
            expect.anything(),
            expect.anything()
        );
    });

    it('enables hard line breaks in the markdown parser for bubble text', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        mount(MarkdownContent, {
            props: {
                content: 'first line\nsecond line',
            },
        });

        expect(getMarkdownMock).toHaveBeenCalledWith(
            'touchai-markdown',
            expect.objectContaining({
                enableContainers: false,
                markdownItOptions: expect.objectContaining({
                    breaks: true,
                }),
            })
        );
    });

    it('updates markstream labels when locale changes after mount', async () => {
        const { setLocale } = await import('@/i18n');
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        mount(MarkdownContent, {
            props: {
                content: '`inline`',
            },
        });

        expect(setDefaultI18nMapMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
                'common.copy': '复制',
            })
        );

        setLocale('en-US');
        await Promise.resolve();

        expect(setDefaultI18nMapMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
                'common.copy': 'Copy',
            })
        );
    });

    it('re-parses rendered markdown after the locale changes so existing controls refresh', async () => {
        parseMarkdownToStructureMock.mockImplementation(() => [
            {
                type: 'code_block',
                label: languageMapMock.plaintext,
            },
        ]);
        const { setLocale } = await import('@/i18n');
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        const wrapper = mount(MarkdownContent, {
            props: {
                content: '```\nhello\n```',
            },
        });

        expect(wrapper.get('[data-testid="markdown-render"]').text()).toBe('纯文本');
        expect(parseMarkdownToStructureMock).toHaveBeenCalledTimes(1);

        setLocale('en-US');
        await nextTick();

        expect(parseMarkdownToStructureMock).toHaveBeenCalledTimes(2);
        expect(wrapper.get('[data-testid="markdown-render"]').text()).toBe('Plain text');
    });

    it('keeps the markdown renderer mounted when streaming content becomes final', async () => {
        parseMarkdownToStructureMock.mockImplementation(() => [
            {
                type: 'text',
                label: 'done',
            },
        ]);
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        const wrapper = mount(MarkdownContent, {
            props: {
                content: 'done',
                final: false,
            },
        });

        await wrapper.setProps({ final: true });

        expect(parseMarkdownToStructureMock).toHaveBeenCalledTimes(2);
        expect(markdownRenderUnmountedMock).not.toHaveBeenCalled();
    });

    it('disables Monaco initial auto-scroll for completed markdown restored from history', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        const wrapper = mount(MarkdownContent, {
            props: {
                content: '```ts\nconsole.log(1)\n```',
                final: true,
            },
        });

        const renderer = wrapper.get('[data-testid="markdown-render"]');
        expect(renderer.attributes('data-code-block-auto-scroll-initial')).toBe('false');
    });

    it('keeps Monaco initial auto-scroll enabled while markdown is still streaming', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        const wrapper = mount(MarkdownContent, {
            props: {
                content: '```ts\nconsole.log(1)',
                final: false,
            },
        });

        const renderer = wrapper.get('[data-testid="markdown-render"]');
        expect(renderer.attributes('data-code-block-auto-scroll-initial')).toBe('true');
    });

    it('marks rendered markdown as not eligible for global DOM localization', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        const wrapper = mount(MarkdownContent, {
            props: {
                content: '设置',
            },
        });

        expect(wrapper.attributes('data-no-i18n')).toBe('true');
        expect(wrapper.attributes('translate')).toBe('no');
    });

    it('uses keyed localized notifications for inline code copy', async () => {
        const { setLocale } = await import('@/i18n');
        setLocale('en-US');
        parseMarkdownToStructureMock.mockReturnValue([]);
        vi.mocked(clipboardService.writeText).mockResolvedValue(undefined);
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        const wrapper = mount(MarkdownContent, {
            props: {
                content: '`pnpm test`',
            },
            attachTo: document.body,
        });
        const code = document.createElement('code');
        code.textContent = 'pnpm test';
        wrapper.element.appendChild(code);

        await code.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(clipboardService.writeText).toHaveBeenCalledWith('pnpm test');
        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'Copied',
        });

        wrapper.unmount();
    });

    it('copies selected tables as semantic clipboard HTML without rendered table styling', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content: '| Name | Value |\n| --- | --- |\n| Alpha | 1 |',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue">
                <table class="table-node" style="border-collapse: separate; border-spacing: 0;">
                    <thead>
                        <tr>
                            <th class="px-3">Name</th>
                            <th class="px-3">Value</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td class="px-3">Alpha</td>
                            <td class="px-3">1</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        `;

        const table = container.querySelector('table')!;
        const range = document.createRange();
        range.selectNode(table);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        const clipboardData = new ClipboardDataStub();
        const copyEvent = new Event('copy', {
            bubbles: true,
            cancelable: true,
        }) as ClipboardEvent;
        Object.defineProperty(copyEvent, 'clipboardData', {
            value: clipboardData,
        });

        const prevented = !container.dispatchEvent(copyEvent);

        expect(prevented).toBe(true);
        expect(clipboardData.getData('text/plain')).toBe('Name\tValue\nAlpha\t1');
        expect(clipboardData.getData('text/html')).toBe(
            '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Alpha</td><td>1</td></tr></tbody></table>'
        );
        expect(clipboardData.getData('text/html')).not.toContain('table-node');
        expect(clipboardData.getData('text/html')).not.toContain('border-collapse');

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('preserves surrounding selected text when cleaning copied table HTML', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content: 'Before\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n\nAfter',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue">
                <p>Before</p>
                <table class="table-node" style="border-collapse: separate;">
                    <tbody>
                        <tr>
                            <td class="px-3">Alpha</td>
                            <td class="px-3">1</td>
                        </tr>
                    </tbody>
                </table>
                <p>After</p>
            </div>
        `;

        const range = document.createRange();
        range.selectNodeContents(container.querySelector('.markstream-vue')!);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);

        const clipboardData = new ClipboardDataStub();
        const copyEvent = new Event('copy', {
            bubbles: true,
            cancelable: true,
        }) as ClipboardEvent;
        Object.defineProperty(copyEvent, 'clipboardData', {
            value: clipboardData,
        });

        const prevented = !container.dispatchEvent(copyEvent);

        expect(prevented).toBe(true);
        expect(clipboardData.getData('text/plain')).toBe('Before\nAlpha\t1\nAfter');
        expect(clipboardData.getData('text/html')).toContain('<p>Before</p>');
        expect(clipboardData.getData('text/html')).toContain(
            '<table><tbody><tr><td>Alpha</td><td>1</td></tr></tbody></table>'
        );
        expect(clipboardData.getData('text/html')).toContain('<p>After</p>');
        expect(clipboardData.getData('text/html')).not.toContain('table-node');
        expect(clipboardData.getData('text/html')).not.toContain('border-collapse');

        selection.removeAllRanges();
        wrapper.unmount();
    });
});
