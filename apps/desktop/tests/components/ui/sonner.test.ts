// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/Sonner 的样式契约。
 *
 * 此前零覆盖。Sonner 是 toast 的渲染入口，它把 toast 的外观全部通过
 * `toast-options` 字符串传进去，所以样式漂移在这里表现为「运行期字符串变了」，
 * 比模板里的 class 更难发现。
 *
 * 注意：AlertMessage 在它之上又封装了一层，并且带有一个全局 owner 抢占逻辑
 * （见审计报告）。那属于阶段 3 的收敛项，不在本测试范围。
 */
import { Sonner } from '@components/ui/sonner';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

function toastOptions(): Record<string, unknown> {
    const wrapper = mount(Sonner, { attachTo: document.body });
    const toaster = wrapper.findComponent({ name: 'Toaster' });

    return (toaster.props('toastOptions') ?? {}) as Record<string, unknown>;
}

describe('ui/Sonner', () => {
    it('anchors toasts at the top centre', () => {
        const wrapper = mount(Sonner, { attachTo: document.body });
        const toaster = wrapper.findComponent({ name: 'Toaster' });

        expect(toaster.props('position')).toBe('top-center');
    });

    it('offsets the stack clear of the search bar', () => {
        const wrapper = mount(Sonner, { attachTo: document.body });
        const toaster = wrapper.findComponent({ name: 'Toaster' });

        expect(toaster.props('offset')).toEqual({ top: 56 });
    });

    it('dismisses after three seconds and offers a close button', () => {
        const wrapper = mount(Sonner, { attachTo: document.body });
        const toaster = wrapper.findComponent({ name: 'Toaster' });

        expect(toaster.props('duration')).toBe(3000);
        expect(toaster.props('closeButton')).toBe(true);
    });

    it('carries the shared toast surface', () => {
        const options = toastOptions();
        const classes = String(options.class ?? '');

        for (const expected of ['rounded-lg', 'border', 'bg-white', 'shadow-sm', 'font-serif']) {
            expect(classes, `toast class missing ${expected}: ${classes}`).toContain(expected);
        }
    });

    it('gives each status its own icon colour', () => {
        const classes = (toastOptions().classes ?? {}) as Record<string, string>;

        expect(classes.success).toContain('text-green-500');
        expect(classes.error).toContain('text-red-500');
        expect(classes.warning).toContain('text-amber-500');
        expect(classes.info).toContain('text-blue-500');
    });

    it('gives the close button a hover state', () => {
        const classes = (toastOptions().classes ?? {}) as Record<string, string>;

        expect(classes.closeButton).toContain('hover:bg-gray-100');
        expect(classes.closeButton).toContain('transition-colors');
    });
});
