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

describe('user sees a badge', () => {
    describe('user sees a capability chip', () => {
        it('user sees the enabled capability chip in blue', () => {
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

        it('user sees a disabled chip in neutral regardless of tone', () => {
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
            'user tone=%s 开启态稳定性',
            (tone) => {
                expect(
                    mountBadge({ variant: 'toggle', tone, active: true }, 'button').classes().sort()
                ).toMatchSnapshot();
            }
        );

        it('user sees the toggle chip stay on one line', () => {
            const classes = mountBadge({ variant: 'toggle', tone: 'blue' }, 'button').classes();
            expect(classes).not.toContain('inline-flex');
            expect(classes).not.toContain('break-words');
            expect(classes).not.toContain('min-w-0');
        });
    });

    describe('user sees a display tag', () => {
        it('user sees the small tag at its narrow width', () => {
            const classes = mountBadge({ variant: 'tag', size: 'sm', tone: 'blue' }).classes();
            expect(classes).toContain('inline-flex');
            expect(classes).toContain('min-w-0');
            expect(classes).toContain('break-words');
            expect(classes).toContain('whitespace-normal');
            expect(classes).toContain('max-w-[5.75rem]');
            expect(classes).toContain('text-2xs');
            expect(classes).toContain('bg-blue-50');
            expect(classes).toContain('text-blue-600');
        });

        it('user sees the medium tag at its fixed width', () => {
            const classes = mountBadge({ variant: 'tag', size: 'md', tone: 'purple' }).classes();
            expect(classes).toContain('max-w-[7.5rem]');
            expect(classes).toContain('text-xs');
            expect(classes).toContain('bg-purple-50');
        });

        it('user sees a display tag that does not react to hover', () => {
            const classes = mountBadge({ variant: 'tag', size: 'md', tone: 'blue' }).classes();
            expect(classes).not.toContain('hover:bg-blue-100');
        });

        it('user tone=gray 使用 gray 色板（toggle 族不使用这个 tone）', () => {
            const classes = mountBadge({ variant: 'tag', size: 'md', tone: 'gray' }).classes();
            expect(classes).toContain('bg-gray-100');
            expect(classes).toContain('text-gray-500');
        });

        it.each(['blue', 'green', 'purple', 'orange', 'indigo', 'gray'] as const)(
            'user tone=%s 尺寸 sm 稳定性',
            (tone) => {
                expect(
                    mountBadge({ variant: 'tag', size: 'sm', tone }).classes().sort()
                ).toMatchSnapshot();
            }
        );
    });

    describe('user sees the badge keep its call-site class', () => {
        it('user keeps the call-site class on the badge', () => {
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
