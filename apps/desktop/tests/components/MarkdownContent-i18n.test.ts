import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { clipboardService } from '@/services/ClipboardService';

const { languageMapMock, notifyMock, parseMarkdownToStructureMock, setDefaultI18nMapMock } =
    vi.hoisted(() => {
        type MarkdownNodeFixture = {
            type: string;
            label?: string;
        };

        return {
            languageMapMock: {} as Record<string, string>,
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
        props: ['nodes'],
        template: '<div data-testid="markdown-render">{{ nodes?.[0]?.label ?? "" }}</div>',
    },
    enableKatex: vi.fn(),
    enableMermaid: vi.fn(),
    getMarkdown: vi.fn(() => ({
        use: vi.fn(),
    })),
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
                    'paths: $env:USERPROFILE\\Desktop, $HOME/project, ${USERPROFILE}\\Desktop, ${env:APPDATA}; math: $x$; code: `echo $HOME`',
            },
        });

        expect(parseMarkdownToStructureMock).toHaveBeenCalledWith(
            'paths: \\$env:USERPROFILE\\Desktop, \\$HOME/project, \\${USERPROFILE}\\Desktop, \\${env:APPDATA}; math: $x$; code: `echo $HOME`',
            expect.anything(),
            expect.anything()
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
});
