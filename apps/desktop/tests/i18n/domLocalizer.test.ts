import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { createDomLocalizer } from '@/i18n/domLocalizer';

describe('DOM localizer', () => {
    let localizer: ReturnType<typeof createDomLocalizer> | null = null;

    afterEach(() => {
        localizer?.stop();
        localizer = null;
        document.body.innerHTML = '';
        setLocale('zh-CN');
    });

    it('translates text nodes and user-facing attributes while preserving whitespace', () => {
        document.body.innerHTML = `
            <main>
                <h1> 设置 </h1>
                <input placeholder="搜索模型名称、ID 或供应商" title="关闭" aria-label="关闭" />
                <img alt="设置" />
            </main>
        `;

        setLocale('en-US');
        localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(document.querySelector('h1')?.textContent).toBe(' Settings ');
        expect(document.querySelector('input')?.getAttribute('placeholder')).toBe(
            'Search model name, ID, or provider'
        );
        expect(document.querySelector('input')?.getAttribute('title')).toBe('Close');
        expect(document.querySelector('input')?.getAttribute('aria-label')).toBe('Close');
        expect(document.querySelector('img')?.getAttribute('alt')).toBe('Settings');

        setLocale('zh-CN');
        localizer.translateNow();

        expect(document.querySelector('h1')?.textContent).toBe(' 设置 ');
        expect(document.querySelector('input')?.getAttribute('placeholder')).toBe(
            '搜索模型名称、ID 或供应商'
        );
        expect(document.querySelector('input')?.getAttribute('title')).toBe('关闭');
        expect(document.querySelector('input')?.getAttribute('aria-label')).toBe('关闭');
        expect(document.querySelector('img')?.getAttribute('alt')).toBe('设置');
    });

    it('translates empty-text and search-placeholder attributes', () => {
        document.body.innerHTML = `
            <section>
                <searchable-select empty-text="没有可选服务商" search-placeholder="搜索服务商"></searchable-select>
            </section>
        `;

        setLocale('en-US');
        localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        const select = document.querySelector('searchable-select');
        expect(select?.getAttribute('empty-text')).toBe('No available providers');
        expect(select?.getAttribute('search-placeholder')).toBe('Search providers');
    });

    it('translates dynamically inserted nodes when observing', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        setLocale('en-US');
        localizer = createDomLocalizer(root);
        localizer.start();

        root.innerHTML = '<button title="最小化">最小化</button>';
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(root.querySelector('button')?.textContent).toBe('Minimize');
        expect(root.querySelector('button')?.getAttribute('title')).toBe('Minimize');
    });

    it('tracks updated original text on reused text nodes', async () => {
        const root = document.createElement('div');
        root.textContent = '设置';
        document.body.appendChild(root);

        setLocale('en-US');
        localizer = createDomLocalizer(root);
        localizer.start();

        expect(root.textContent).toBe('Settings');

        root.firstChild!.nodeValue = '关闭';
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(root.textContent).toBe('Close');

        setLocale('zh-CN');
        localizer.translateNow();
        expect(root.textContent).toBe('关闭');
    });

    it('skips code-like and editable content', () => {
        document.body.innerHTML = `
            <pre>设置</pre>
            <code>关闭</code>
            <textarea>最小化</textarea>
            <div contenteditable="true">设置</div>
            <p>设置</p>
        `;

        setLocale('en-US');
        localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(document.querySelector('pre')?.textContent).toBe('设置');
        expect(document.querySelector('code')?.textContent).toBe('关闭');
        expect(document.querySelector('textarea')?.textContent).toBe('最小化');
        expect(document.querySelector('[contenteditable="true"]')?.textContent).toBe('设置');
        expect(document.querySelector('p')?.textContent).toBe('Settings');
    });

    it('skips explicitly opted-out content while translating nearby UI', () => {
        document.body.innerHTML = `
            <section>
                <button title="关闭">设置</button>
                <article data-no-i18n>
                    <p>设置</p>
                    <input title="关闭" placeholder="搜索标题或消息内容" />
                </article>
                <div translate="no">最小化</div>
            </section>
        `;

        setLocale('en-US');
        localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(document.querySelector('button')?.textContent).toBe('Settings');
        expect(document.querySelector('button')?.getAttribute('title')).toBe('Close');
        expect(document.querySelector('article p')?.textContent).toBe('设置');
        expect(document.querySelector('article input')?.getAttribute('title')).toBe('关闭');
        expect(document.querySelector('article input')?.getAttribute('placeholder')).toBe(
            '搜索标题或消息内容'
        );
        expect(document.querySelector('[translate="no"]')?.textContent).toBe('最小化');
    });

    it('leaves nested opt-out subtrees untouched while translating sibling text', () => {
        document.body.innerHTML = `
            <section>
                <div data-no-i18n>
                    <p>设置</p>
                    <span>
                        <button title="关闭">最小化</button>
                    </span>
                </div>
                <div translate="no">
                    <p>关闭</p>
                    <span title="设置">设置</span>
                </div>
                <p>设置</p>
            </section>
        `;

        setLocale('en-US');
        localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(document.querySelector('[data-no-i18n] p')?.textContent).toBe('设置');
        expect(document.querySelector('[data-no-i18n] button')?.textContent).toBe('最小化');
        expect(document.querySelector('[data-no-i18n] button')?.getAttribute('title')).toBe('关闭');
        expect(document.querySelector('[translate="no"] p')?.textContent).toBe('关闭');
        expect(document.querySelector('[translate="no"] span')?.textContent).toBe('设置');
        expect(document.querySelector('[translate="no"] span')?.getAttribute('title')).toBe('设置');
        expect(document.querySelector('section > p')?.textContent).toBe('Settings');
    });
});
