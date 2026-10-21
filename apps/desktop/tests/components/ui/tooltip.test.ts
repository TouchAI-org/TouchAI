// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/Tooltip 的基础行为测试。
 *
 * jsdom 不驱动真实的 pointer/hover 时序，reka-ui 的 content 显隐依赖
 * pointerenter + 定时器，在 jsdom 里不稳定。因此这里只锁定两件能被可靠
 * 断言的事：
 *   1. as-child 的触发元素保持原标签，不被额外 DOM 包裹
 *   2. TooltipContent 的样式类固定（这是迁移后唯一的视觉契约）
 *
 * 真实的悬停显示行为由 e2e 覆盖，不在单测里假装验证。
 */
import { Tooltip, TooltipContent, TooltipTrigger } from '@components/ui/tooltip';
import { flushPromises, mount } from '@vue/test-utils';
import { TooltipProvider } from 'reka-ui';
import { describe, expect, it } from 'vitest';

describe('ui/Tooltip', () => {
    it('as-child 的触发元素保持原有标签', () => {
        const wrapper = mount({
            components: { Tooltip, TooltipTrigger },
            template: `
                <Tooltip text="提示">
                    <TooltipTrigger as-child>
                        <button type="button" data-testid="trigger">hover me</button>
                    </TooltipTrigger>
                </Tooltip>
            `,
        });

        const trigger = wrapper.get('[data-testid="trigger"]');
        expect(trigger.element.tagName).toBe('BUTTON');
    });

    it('content 携带项目既有的卡片样式', async () => {
        const wrapper = mount(
            {
                components: { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider },
                template: `
                    <Tooltip :open="true" :delay-duration="0">
                        <TooltipTrigger as-child>
                            <button type="button" data-testid="trigger">x</button>
                        </TooltipTrigger>
                        <TooltipContent force-mount>内容文本</TooltipContent>
                    </Tooltip>
                `,
            },
            { attachTo: document.body }
        );

        await flushPromises();

        /*
         * reka-ui 把 role="tooltip" 放在一个 sr-only 的 <span> 上（供屏幕阅读器），
         * 实际可见的卡片是它的父元素，class 在父元素上。
         */
        const srOnly = document.querySelector('[role="tooltip"]');
        expect(srOnly).not.toBeNull();
        const content = srOnly?.parentElement;
        expect(content).not.toBeNull();

        const classes = Array.from(content?.classList ?? []);
        for (const expected of [
            'z-50',
            'max-w-xs',
            'rounded-md',
            'border',
            'border-neutral-200',
            'bg-white',
            'px-2',
            'py-1',
            'text-xs',
            'leading-5',
            'text-neutral-700',
            'shadow-md',
        ]) {
            expect(classes, `缺少 ${expected}；实际 class: ${classes.join(' ')}`).toContain(
                expected
            );
        }
        expect(content?.textContent).toContain('内容文本');
        wrapper.unmount();
    });
});
