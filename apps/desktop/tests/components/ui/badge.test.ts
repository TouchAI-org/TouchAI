// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/Badge 的 class 快照与行为测试。
 *
 * 两族标签的基础类不同（toggle 可点击有 hover，tag 不可点击但需 min-w-0 /
 * break-words / max-w-* 才能不溢出），测试分别锁定，防止将来被「统一」。
 */
import Badge from '@components/ui/badge/Badge.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

const mountBadge = (props: Record<string, unknown> = {}, as = 'span') =>
    mount(Badge, {
        props: { as, ...props },
        slots: { default: 'label' },
        attachTo: document.body,
    });

describe('ui/Badge', () => {
    describe('toggle 族（能力开关 chip）', () => {
        it('开启态的 blue 输出原 capability chip 的类', () => {
            const classes = mountBadge({ variant: 'toggle', tone: 'blue', active: true }, 'button')
                .classes()
                .sort();
            expect(classes).toMatchSnapshot();
            for (const expected of [
                'rounded',
                'px-1.5',
                'py-0.5',
                'text-xs',
                'font-medium',
                'transition-colors',
                'bg-blue-50',
                'text-blue-600',
                'hover:bg-blue-100',
            ]) {
                expect(classes).toContain(expected);
            }
        });

        it('关闭态统一用 neutral，忽略 tone', () => {
            const classes = mountBadge(
                { variant: 'toggle', tone: 'green', active: false },
                'button'
            ).classes();
            expect(classes).toContain('bg-neutral-100');
            expect(classes).toContain('text-neutral-400');
            expect(classes).toContain('hover:bg-neutral-200');
            expect(classes).not.toContain('bg-green-50');
        });

        it.each(['blue', 'green', 'purple', 'orange', 'indigo'] as const)(
            'tone=%s 开启态稳定性',
            (tone) => {
                expect(
                    mountBadge({ variant: 'toggle', tone, active: true }, 'button').classes().sort()
                ).toMatchSnapshot();
            }
        );

        it('toggle 族不携带 tag 族的换行类', () => {
            const classes = mountBadge({ variant: 'toggle', tone: 'blue' }, 'button').classes();
            expect(classes).not.toContain('inline-flex');
            expect(classes).not.toContain('break-words');
            expect(classes).not.toContain('min-w-0');
        });
    });

    describe('tag 族（能力展示标签）', () => {
        it('size=sm 携带窄宽度与 10px 字号', () => {
            const classes = mountBadge({ variant: 'tag', size: 'sm', tone: 'blue' }).classes();
            expect(classes).toContain('inline-flex');
            expect(classes).toContain('min-w-0');
            expect(classes).toContain('break-words');
            expect(classes).toContain('whitespace-normal');
            expect(classes).toContain('max-w-[5.75rem]');
            expect(classes).toContain('text-[10px]');
            expect(classes).toContain('bg-blue-50');
            expect(classes).toContain('text-blue-600');
        });

        it('size=md 携带 7.5rem 宽度与 xs 字号', () => {
            const classes = mountBadge({ variant: 'tag', size: 'md', tone: 'purple' }).classes();
            expect(classes).toContain('max-w-[7.5rem]');
            expect(classes).toContain('text-xs');
            expect(classes).toContain('bg-purple-50');
        });

        it('tag 族没有 hover 变色', () => {
            const classes = mountBadge({ variant: 'tag', size: 'md', tone: 'blue' }).classes();
            expect(classes).not.toContain('hover:bg-blue-100');
        });

        it('tone=gray 使用 gray 色板（toggle 族不使用这个 tone）', () => {
            const classes = mountBadge({ variant: 'tag', size: 'md', tone: 'gray' }).classes();
            expect(classes).toContain('bg-gray-100');
            expect(classes).toContain('text-gray-500');
        });

        it.each(['blue', 'green', 'purple', 'orange', 'indigo', 'gray'] as const)(
            'tone=%s 尺寸 sm 稳定性',
            (tone) => {
                expect(
                    mountBadge({ variant: 'tag', size: 'sm', tone }).classes().sort()
                ).toMatchSnapshot();
            }
        );
    });

    describe('调用点附加 class 会合并', () => {
        it('额外 class 追加', () => {
            const classes = mountBadge({
                variant: 'tag',
                size: 'md',
                tone: 'blue',
                class: 'custom',
            }).classes();
            expect(classes).toContain('custom');
            expect(classes).toContain('bg-blue-50');
        });
    });
});
