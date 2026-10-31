import { deferred, installProductAnalytics } from '@tests/utils/productAnalytics';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import MarkdownRender, { type ParsedNode } from 'markstream-vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { setLocale } from '@/i18n';

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({
    sendNotification: notifyMock,
    isPermissionGranted: vi.fn(),
    requestPermission: vi.fn(),
}));
enableAutoUnmount(afterEach);
afterEach(() => {
    vi.unstubAllGlobals();
});

class ClipboardDataStub {
    private readonly data = new Map<string, string>();

    setData(type: string, value: string) {
        this.data.set(type, value);
    }

    getData(type: string) {
        return this.data.get(type) ?? '';
    }
}

function requiredTextNode(nodes: NodeListOf<Element>, index: number): Text {
    const textNode = nodes.item(index)?.firstChild;
    expect(textNode).toBeInstanceOf(Text);

    return textNode as Text;
}

describe('user reads a markdown answer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        installProductAnalytics();
        setLocale('zh-CN');
        mockTauriCommand('write_clipboard_text', undefined);
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            }
        );
    });

    it('user preserves the original code typography and the File/Diff theme order', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: { content: '```javascript\nconst value = 1;\n```', final: true },
        });
        const renderer = wrapper.findComponent(MarkdownRender);

        expect(renderer.props('themes')).toEqual(['one-dark-pro', 'one-light']);
        expect(renderer.props('codeBlockMonacoOptions')).toMatchObject({
            fontSize: 14,
            lineHeight: 19,
            fontFamily: "Consolas, 'Courier New', monospace",
            glyphMargin: false,
            autoScrollInitial: false,
        });
        // Trusted application CSS is passed through the supported Shadow DOM hook.
        expect(renderer.props('codeBlockMonacoOptions').unsafeCSS).toContain('pre[data-file]');
    });

    it.each(['default', 'reasoning'] as const)(
        'user disables soft wrapping for streaming and finalized code/diff blocks in %s messages',
        async (variant) => {
            const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
            const content = '```text\n' + 'long code line '.repeat(100) + '\nsecond line';
            const wrapper = mount(MarkdownContent, {
                props: { content, final: false, variant },
            });
            const renderer = wrapper.findComponent(MarkdownRender);

            expect(renderer.props('codeBlockMonacoOptions')).toMatchObject({
                wordWrap: 'off',
                diffWordWrap: 'off',
                autoScrollInitial: true,
            });

            await wrapper.setProps({ content: content + '\n```', final: true });
            expect(renderer.props('codeBlockMonacoOptions')).toMatchObject({
                wordWrap: 'off',
                diffWordWrap: 'off',
                autoScrollInitial: false,
            });
            wrapper.unmount();
        }
    );

    it('user passes the TouchAI scrollbar skin into the File/Diff Shadow DOM', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: { content: '```javascript\nconst value = 1;\n```', final: true },
        });
        const renderer = wrapper.findComponent(MarkdownRender);
        const styles = renderer.props('codeBlockMonacoOptions').unsafeCSS;

        expect(styles).toContain('[data-code]::-webkit-scrollbar-thumb');
        expect(styles).toContain('var(--color-scrollbar-thumb)');
        expect(styles).toContain('var(--color-scrollbar-thumb-hover)');
        expect(styles).toContain('[data-code]::-webkit-scrollbar-button');
        expect(styles).toContain('display: none');
    });

    it('user bypasses self-root viewport deferral without disabling batched rendering', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: { content: '```javascript\n' + 'x'.repeat(900) + '\n```', final: true },
        });
        const renderer = wrapper.findComponent(MarkdownRender);

        expect(renderer.props('viewportPriority')).toBe(false);
        expect(renderer.props('batchRendering')).toBe(true);
        expect(renderer.props('maxLiveNodes')).toBe(0);
        await wrapper.setProps({ variant: 'reasoning' });
        expect(wrapper.findComponent(MarkdownRender).props('maxLiveNodes')).toBe(320);
    });

    it('user sees code copy controls in English after selecting the English locale', async () => {
        setLocale('en-US');
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, { props: { content: '```text\nhello\n```' } });
        await vi.dynamicImportSettled();
        await flushPromises();
        expect(wrapper.find('button[aria-label="Copy"]').exists()).toBe(true);
        expect(wrapper.find('button[aria-label="复制"]').exists()).toBe(false);
    });

    it('user reads shell variables literally while formulas and inline code retain their meaning', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content:
                    'paths: $env:USERPROFILE\\Desktop, $HOME/project, ${USERPROFILE}\\Desktop, ${env:APPDATA}; math: $x$ and $x+y$; code: `echo $HOME`',
            },
        });
        await flushPromises();
        expect(wrapper.text()).toContain('$env:USERPROFILE\\Desktop');
        expect(wrapper.text()).toContain('$HOME/project');
        expect(wrapper.text()).toContain('${USERPROFILE}\\Desktop');
        expect(wrapper.text()).toContain('${env:APPDATA}');
        expect(wrapper.get('code').text()).toBe('echo $HOME');
        const nodes = wrapper.findComponent(MarkdownRender).props('nodes') as ParsedNode[];
        expect(JSON.stringify(nodes)).toContain('math_inline');
    });

    it('user sees a hard line break between adjacent lines in an answer', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, { props: { content: 'first line\nsecond line' } });
        await flushPromises();
        // Markstream preserves the parsed newline in a pre-wrap text node.
        expect(wrapper.get('p').element.textContent).toBe('first line\nsecond line');
        expect(wrapper.text()).toContain('first line');
        expect(wrapper.text()).toContain('second line');
    });

    it('user sees existing code copy controls change language after changing locale', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, { props: { content: '```text\nhello\n```' } });
        await vi.dynamicImportSettled();
        await flushPromises();
        expect(wrapper.find('button[aria-label="复制"]').exists()).toBe(true);
        setLocale('en-US');
        await nextTick();
        await flushPromises();
        expect(wrapper.find('button[aria-label="Copy"]').exists()).toBe(true);
    });

    it('user keeps the rendered answer mounted when streaming content becomes final', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, { props: { content: 'done', final: false } });
        const rendered = wrapper.findComponent(MarkdownRender).element;
        await wrapper.setProps({ final: true });
        expect(wrapper.findComponent(MarkdownRender).element).toBe(rendered);
        expect(wrapper.text()).toContain('done');
    });

    it.each([
        ['streaming', false],
        ['restored from history', true],
    ] as const)(
        'user sees code with matching initial scrolling when the answer is %s',
        async (_state, final) => {
            const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
            const wrapper = mount(MarkdownContent, {
                props: { content: '```ts\nconsole.log(1)\n```', final },
            });
            expect(
                wrapper.findComponent(MarkdownRender).props('codeBlockMonacoOptions')
                    .autoScrollInitial
            ).toBe(!final);
        }
    );

    it('user marks rendered markdown as not eligible for global DOM localization', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');

        const wrapper = mount(MarkdownContent, {
            props: {
                content: '设置',
            },
        });

        expect(wrapper.attributes('data-no-i18n')).toBe('true');
        expect(wrapper.attributes('translate')).toBe('no');
    });

    it('user uses keyed localized notifications for inline code copy', async () => {
        setLocale('en-US');
        const telemetry = installProductAnalytics();
        const write = deferred<void>();
        mockTauriCommand('write_clipboard_text', () => write.promise);
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: { content: '`pnpm test`' },
            attachTo: document.body,
        });
        await flushPromises();
        await wrapper.get('code').trigger('click');
        await flushPromises();
        expect(getTauriInvokeCalls('write_clipboard_text')[0]?.payload).toEqual({
            text: 'pnpm test',
        });
        expect(notifyMock).not.toHaveBeenCalled();
        expect(telemetry.events).toEqual([]);
        write.resolve();
        await flushPromises();
        expect(notifyMock).toHaveBeenCalledWith({ title: 'TouchAI', body: 'Copied' });
        expect(telemetry.events[0]?.attributes).toMatchObject({
            action: 'copy_code',
            result: 'success',
        });
        expect(telemetry.released).toEqual(['operation-1']);
    });

    it('user sees a localized failure when a rendered inline code write is refused', async () => {
        setLocale('en-US');
        const write = deferred<void>();
        mockTauriCommand('write_clipboard_text', () => write.promise);
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, { props: { content: '`pnpm test`' } });
        await flushPromises();
        await wrapper.get('code').trigger('click');
        write.reject(new Error('clipboard denied'));
        await flushPromises();
        expect(notifyMock).toHaveBeenCalledWith({ title: 'TouchAI', body: 'Copy failed' });
        expect(notifyMock).not.toHaveBeenCalledWith({ title: 'TouchAI', body: 'Copied' });
    });

    it('user copies selected tables as Word-compatible grid table clipboard HTML', async () => {
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
            '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse: collapse;"><thead><tr><th style="border: 1px solid #000; padding: 4px;">Name</th><th style="border: 1px solid #000; padding: 4px;">Value</th></tr></thead><tbody><tr><td style="border: 1px solid #000; padding: 4px;">Alpha</td><td style="border: 1px solid #000; padding: 4px;">1</td></tr></tbody></table>'
        );
        expect(clipboardData.getData('text/html')).not.toContain('table-node');
        expect(clipboardData.getData('text/html')).not.toContain('border-collapse: separate');
        expect(clipboardData.getData('text/html')).not.toContain('border-spacing');

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('user preserves inline semantics inside copied table cell HTML', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content: '| Link | Preview |\n| --- | --- |\n| Docs | code |',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue">
                <table class="table-node" style="border-collapse: separate;">
                    <tbody>
                        <tr>
                            <td class="px-3"><a class="link-token" style="color: blue;" href="https://example.com/docs">Docs</a></td>
                            <td class="px-3"><img src="data:image/png;base64,AAAA" alt="Inline image"><span>Preview</span></td>
                        </tr>
                        <tr>
                            <td class="px-3"><code class="language-ts">code</code></td>
                            <td class="px-3"><a href="javascript:alert(1)">unsafe</a></td>
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
        expect(clipboardData.getData('text/plain')).toBe('Docs\tPreview\ncode\tunsafe');
        expect(clipboardData.getData('text/html')).toBe(
            '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse: collapse;"><tbody><tr><td style="border: 1px solid #000; padding: 4px;"><a href="https://example.com/docs">Docs</a></td><td style="border: 1px solid #000; padding: 4px;"><img src="data:image/png;base64,AAAA" alt="Inline image">Preview</td></tr><tr><td style="border: 1px solid #000; padding: 4px;"><code>code</code></td><td style="border: 1px solid #000; padding: 4px;"><a>unsafe</a></td></tr></tbody></table>'
        );
        expect(clipboardData.getData('text/html')).not.toContain('class=');
        expect(clipboardData.getData('text/html')).not.toContain('javascript:');

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('user preserves surrounding selected text when cleaning copied table HTML', async () => {
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
            '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse: collapse;"><tbody><tr><td style="border: 1px solid #000; padding: 4px;">Alpha</td><td style="border: 1px solid #000; padding: 4px;">1</td></tr></tbody></table>'
        );
        expect(clipboardData.getData('text/html')).toContain('<p>After</p>');
        expect(clipboardData.getData('text/html')).not.toContain('table-node');
        expect(clipboardData.getData('text/html')).not.toContain('border-collapse: separate');

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('user clips copied selections to the markdown container bounds', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content: 'Inside text',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        const outside = document.createElement('p');
        outside.textContent = 'Outside';
        container.parentNode?.insertBefore(outside, container);
        container.innerHTML = `
            <div class="markstream-vue">
                <p>Inside <strong>text</strong></p>
            </div>
        `;

        const insideText = container.querySelector('strong')!.firstChild!;
        const range = document.createRange();
        range.setStart(outside.firstChild!, 0);
        range.setEnd(insideText, insideText.textContent!.length);
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
        expect(clipboardData.getData('text/plain')).toBe('Inside text');
        expect(clipboardData.getData('text/html')).toBe('<p>Inside <strong>text</strong></p>');
        expect(clipboardData.getData('text/plain')).not.toContain('Outside');

        selection.removeAllRanges();
        outside.remove();
        wrapper.unmount();
    });

    it('user copies mixed markdown selections as clean semantic clipboard HTML and readable plain text', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content:
                    '## Title\n\nIntro **bold**\n\n- First\n- Second\n\n```ts\nconst x = 1;\n```',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue" style="color: red;">
                <h2 class="heading-token" style="font-size: 28px;">Title</h2>
                <p class="paragraph-token" style="margin: 0;">Intro <strong class="font-bold">bold</strong></p>
                <ul class="list-token" style="padding-left: 32px;">
                    <li class="item-token"><span style="color: blue;">First</span></li>
                    <li class="item-token">Second</li>
                </ul>
                <pre class="code-block" style="background: #111;"><code class="language-ts">const x = 1;</code></pre>
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
        expect(clipboardData.getData('text/plain')).toBe(
            'Title\nIntro bold\n- First\n- Second\nconst x = 1;'
        );
        expect(clipboardData.getData('text/html')).toBe(
            '<h2>Title</h2><p>Intro <strong>bold</strong></p><ul><li>First</li><li>Second</li></ul><pre><code>const x = 1;</code></pre>'
        );
        expect(clipboardData.getData('text/html')).not.toContain('class=');
        expect(clipboardData.getData('text/html')).not.toContain('style=');

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('user flattens paragraph wrappers inside copied list items for Word-compatible list HTML', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content:
                    '- **Objective**(目标): 建立清晰目标\n- Key Results: 可量化结果\n\n1. 公开透明\n2. 季度周期',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue">
                <ul class="list-token">
                    <li class="item-token"><p><strong>Objective</strong>(目标): 建立清晰目标</p></li>
                    <li class="item-token"><p>Key Results: 可量化结果</p></li>
                </ul>
                <ol class="list-token">
                    <li class="item-token"><p>公开透明</p></li>
                    <li class="item-token"><p>季度周期</p></li>
                </ol>
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
        expect(clipboardData.getData('text/plain')).toBe(
            '- Objective(目标): 建立清晰目标\n- Key Results: 可量化结果\n1. 公开透明\n2. 季度周期'
        );
        expect(clipboardData.getData('text/html')).toBe(
            '<ul><li><strong>Objective</strong>(目标): 建立清晰目标</li><li>Key Results: 可量化结果</li></ul><ol><li>公开透明</li><li>季度周期</li></ol>'
        );
        expect(clipboardData.getData('text/html')).not.toContain('<li><p>');

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('user flattens nested renderer wrappers inside copied list items for Word-compatible list HTML', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content:
                    '1. 设定太多目标：贪多嚼不烂\n2. 全是常规工作：OKR 应聚焦突破性目标\n3. 缺乏衡量标准：关键结果必须可量化',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue">
                <ol class="list-node list-decimal">
                    <li class="list-item">
                        <div class="markdown-renderer">
                            <span class="node-slot">
                                <span class="node-content">
                                    <p class="paragraph-node">设定太多目标：贪多嚼不烂</p>
                                </span>
                            </span>
                        </div>
                    </li>
                    <li class="list-item">
                        <div class="markdown-renderer">
                            <span class="node-slot">
                                <span class="node-content">
                                    <p class="paragraph-node">全是常规工作：OKR 应聚焦突破性目标</p>
                                </span>
                            </span>
                        </div>
                    </li>
                    <li class="list-item">
                        <div class="markdown-renderer">
                            <span class="node-slot">
                                <span class="node-content">
                                    <p class="paragraph-node">缺乏衡量标准：关键结果必须可量化</p>
                                </span>
                            </span>
                        </div>
                    </li>
                </ol>
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
        expect(clipboardData.getData('text/plain')).toBe(
            '1. 设定太多目标：贪多嚼不烂\n2. 全是常规工作：OKR 应聚焦突破性目标\n3. 缺乏衡量标准：关键结果必须可量化'
        );
        expect(clipboardData.getData('text/html')).toBe(
            '<ol><li>设定太多目标：贪多嚼不烂</li><li>全是常规工作：OKR 应聚焦突破性目标</li><li>缺乏衡量标准：关键结果必须可量化</li></ol>'
        );
        expect(clipboardData.getData('text/html')).not.toContain('<p');
        expect(clipboardData.getData('text/html')).not.toContain('markdown-renderer');

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('user wraps partially selected list items in their list parent for Word-compatible clipboard HTML', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content:
                    '1. 设定太多目标：贪多嚼不烂\n2. 全是常规工作：OKR 应聚焦突破性目标\n3. 缺乏衡量标准：关键结果必须可量化',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue">
                <ol class="list-node list-decimal">
                    <li class="list-item"><p class="paragraph-node">设定太多目标：贪多嚼不烂</p></li>
                    <li class="list-item"><p class="paragraph-node">全是常规工作：OKR 应聚焦突破性目标</p></li>
                    <li class="list-item"><p class="paragraph-node">缺乏衡量标准：关键结果必须可量化</p></li>
                </ol>
            </div>
        `;

        const paragraphs = container.querySelectorAll('.paragraph-node');
        const firstText = requiredTextNode(paragraphs, 0);
        const lastText = requiredTextNode(paragraphs, 2);
        const range = document.createRange();
        range.setStart(firstText, 0);
        range.setEnd(lastText, lastText.textContent!.length);
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
        expect(clipboardData.getData('text/plain')).toBe(
            '1. 设定太多目标：贪多嚼不烂\n2. 全是常规工作：OKR 应聚焦突破性目标\n3. 缺乏衡量标准：关键结果必须可量化'
        );
        expect(clipboardData.getData('text/html')).toBe(
            '<ol><li>设定太多目标：贪多嚼不烂</li><li>全是常规工作：OKR 应聚焦突破性目标</li><li>缺乏衡量标准：关键结果必须可量化</li></ol>'
        );

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('user preserves ordered list numbering when a copied list selection starts after the first item', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content: '1. 跳过第一项\n2. 保留第二项编号\n3. 保留第三项编号',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue">
                <ol class="list-node list-decimal">
                    <li class="list-item"><p class="paragraph-node">跳过第一项</p></li>
                    <li class="list-item"><p class="paragraph-node">保留第二项编号</p></li>
                    <li class="list-item"><p class="paragraph-node">保留第三项编号</p></li>
                </ol>
            </div>
        `;

        const paragraphs = container.querySelectorAll('.paragraph-node');
        const secondText = requiredTextNode(paragraphs, 1);
        const thirdText = requiredTextNode(paragraphs, 2);
        const range = document.createRange();
        range.setStart(secondText, 0);
        range.setEnd(thirdText, thirdText.textContent!.length);
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
        expect(clipboardData.getData('text/plain')).toBe('2. 保留第二项编号\n3. 保留第三项编号');
        expect(clipboardData.getData('text/html')).toBe(
            '<ol start="2"><li>保留第二项编号</li><li>保留第三项编号</li></ol>'
        );

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('user preserves link targets and document structure in copied plain text fallbacks', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content:
                    '## Install\n\nRead [docs](https://example.com/docs) first.\n\n> Keep warning\n\n---',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue" style="color: red;">
                <h2 class="heading-token">Install</h2>
                <p>Read <a class="link-token" style="color: blue;" href="https://example.com/docs">docs</a> first.</p>
                <blockquote class="quote-token"><p>Keep warning</p></blockquote>
                <hr class="rule-token">
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
        expect(clipboardData.getData('text/plain')).toBe(
            'Install\nRead [docs](https://example.com/docs) first.\nKeep warning'
        );
        expect(clipboardData.getData('text/html')).toBe(
            '<h2>Install</h2><p>Read <a href="https://example.com/docs">docs</a> first.</p><blockquote><p>Keep warning</p></blockquote><hr>'
        );
        expect(clipboardData.getData('text/html')).not.toContain('class=');
        expect(clipboardData.getData('text/html')).not.toContain('style=');

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('user drops unsafe clipboard URL schemes while preserving safe image data URLs', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content: 'Safe docs bad js image',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue">
                <p>
                    Safe <a href="https://example.com/docs">docs</a>
                    <a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">bad</a>
                    <a href="javascript:alert(1)">js</a>
                </p>
                <p>
                    <img src="data:image/png;base64,AAAA" alt="Inline image">
                    <img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" alt="Bad image">
                </p>
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
        expect(clipboardData.getData('text/plain')).toBe(
            'Safe [docs](https://example.com/docs) bad js\n[Inline image]'
        );
        expect(clipboardData.getData('text/html')).toContain(
            '<a href="https://example.com/docs">docs</a>'
        );
        expect(clipboardData.getData('text/html')).toContain(
            '<img src="data:image/png;base64,AAAA" alt="Inline image">'
        );
        expect(clipboardData.getData('text/html')).not.toContain('javascript:');
        expect(clipboardData.getData('text/html')).not.toContain('data:text/html');

        selection.removeAllRanges();
        wrapper.unmount();
    });

    it('user preserves inline spacing while skipping non-content clipboard artifacts', async () => {
        const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
        const wrapper = mount(MarkdownContent, {
            props: {
                content: 'Alpha Beta Gamma',
            },
            attachTo: document.body,
        });

        const container = wrapper.element as HTMLElement;
        container.innerHTML = `
            <div class="markstream-vue">
                <p>
                    <strong>Alpha</strong> <em>Beta</em>
                    <button>Copy</button>
                    <span aria-hidden="true">Hidden</span>
                    <span style="display: none;">Invisible</span>
                    <style>.word-rule { color: red; }</style>
                    <script>window.noise = true;</script>
                    Gamma
                </p>
            </div>
        `;

        const range = document.createRange();
        range.selectNodeContents(container.querySelector('p')!);
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
        expect(clipboardData.getData('text/plain')).toBe('Alpha Beta Gamma');
        expect(clipboardData.getData('text/html')).toBe(
            '<strong>Alpha</strong> <em>Beta</em> Gamma'
        );
        expect(clipboardData.getData('text/html')).not.toContain('Copy');
        expect(clipboardData.getData('text/html')).not.toContain('Hidden');
        expect(clipboardData.getData('text/html')).not.toContain('word-rule');
        expect(clipboardData.getData('text/html')).not.toContain('script');

        selection.removeAllRanges();
        wrapper.unmount();
    });
});
