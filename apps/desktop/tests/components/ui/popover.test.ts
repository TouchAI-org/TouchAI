// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/Popover 的基础测试。
 *
 * 现有两个 popover（SessionHistoryPopover / ModelDropdownPopup）是受控的
 * 绝对定位 div，不是 portal 弹层。改用 reka-ui Popover 会引入 portal +
 * focus 管理 + 外部点击关闭的行为变化，因此本 PR 只提供原语与样式，
 * 不改动那两个调用点。这里锁定原语的样式契约。
 */
import { Popover, PopoverContent, PopoverTrigger } from '@components/ui/popover';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

describe('ui/Popover', () => {
    it('as-child 的触发元素保持原有标签', () => {
        const wrapper = mount({
            components: { Popover, PopoverTrigger },
            template: `
                <Popover :open="false">
                    <PopoverTrigger as-child>
                        <button type="button" data-testid="trigger">open</button>
                    </PopoverTrigger>
                </Popover>
            `,
        });
        expect(wrapper.get('[data-testid="trigger"]').element.tagName).toBe('BUTTON');
    });

    it('content 携带既有弹层卡片样式', async () => {
        mount(
            {
                components: { Popover, PopoverContent, PopoverTrigger },
                template: `
                    <Popover :open="true">
                        <PopoverTrigger as-child>
                            <button type="button">open</button>
                        </PopoverTrigger>
                        <PopoverContent force-mount>面板内容</PopoverContent>
                    </Popover>
                `,
            },
            { attachTo: document.body }
        );

        await flushPromises();

        const content = document.querySelector('[data-reka-popper-content-wrapper] > div');
        expect(content).not.toBeNull();

        const classes = Array.from(content?.classList ?? []);
        for (const expected of [
            'z-50',
            'overflow-hidden',
            'rounded-lg',
            'border',
            'border-stone-200/90',
            'bg-white',
            'shadow-lg',
        ]) {
            expect(classes, `缺少 ${expected}；实际: ${classes.join(' ')}`).toContain(expected);
        }
        expect(content?.textContent).toContain('面板内容');
    });
});
