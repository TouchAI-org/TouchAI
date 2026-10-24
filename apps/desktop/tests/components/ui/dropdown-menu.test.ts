// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/DropdownMenu 的样式契约。
 *
 * 此前零覆盖。它只被 ContextMenu 使用，但右键菜单的关闭动画依赖
 * `t-dropdown` 这个 presence 钩子，去掉后菜单会瞬间消失。
 */
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@components/ui/dropdown-menu';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
    document.body.innerHTML = '';
});

function mountMenu() {
    return mount(
        {
            components: {
                DropdownMenu,
                DropdownMenuContent,
                DropdownMenuItem,
                DropdownMenuTrigger,
            },
            template: `
                <DropdownMenu :open="true">
                    <DropdownMenuTrigger as-child>
                        <button type="button" data-testid="trigger">打开</button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent force-mount>
                        <DropdownMenuItem>复制</DropdownMenuItem>
                        <DropdownMenuItem disabled>删除</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            `,
        },
        { attachTo: document.body }
    );
}

function menuContent(): Element | null {
    return document.querySelector('[role="menu"]');
}

describe('ui/DropdownMenu', () => {
    it('renders the content with the t-dropdown presence hook', async () => {
        mountMenu();
        await flushPromises();

        const content = menuContent();
        expect(content, 'menu content missing').not.toBeNull();
        expect(Array.from(content?.classList ?? [])).toContain('t-dropdown');
    });

    it('renders one menu item per child', async () => {
        mountMenu();
        await flushPromises();

        const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
        expect(items.length).toBeGreaterThanOrEqual(2);
    });

    it('renders item labels', async () => {
        mountMenu();
        await flushPromises();

        const text = menuContent()?.textContent ?? '';
        expect(text).toContain('复制');
        expect(text).toContain('删除');
    });

    it('gives items a pointer cursor and transition', async () => {
        mountMenu();
        await flushPromises();

        const item = document.querySelector('[role="menuitem"]');
        const classes = Array.from(item?.classList ?? []);

        expect(classes).toContain('cursor-pointer');
        expect(classes).toContain('transition-colors');
    });

    it('marks disabled items so they cannot be interacted with', async () => {
        mountMenu();
        await flushPromises();

        const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
        const disabled = items.find((item) => item.textContent?.includes('删除'));

        expect(disabled?.hasAttribute('data-disabled')).toBe(true);
    });

    it('keeps the trigger element when as-child is used', async () => {
        mountMenu();
        await flushPromises();

        expect(document.querySelector('[data-testid="trigger"]')?.tagName).toBe('BUTTON');
    });

    it('accepts a call-site class on the content', async () => {
        mount(
            {
                components: { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger },
                template: `
                    <DropdownMenu :open="true">
                        <DropdownMenuTrigger as-child>
                            <button type="button">打开</button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent class="min-w-[200px]" force-mount>内容</DropdownMenuContent>
                    </DropdownMenu>
                `,
            },
            { attachTo: document.body }
        );
        await flushPromises();

        expect(Array.from(menuContent()?.classList ?? [])).toContain('min-w-[200px]');
    });
});
