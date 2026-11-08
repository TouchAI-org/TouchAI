import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

const events = vi.hoisted(() => ({
    handler: undefined as undefined | ((event: { payload: unknown }) => void),
    unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    getCurrentWebviewWindow: () => ({
        listen: async (_name: string, handler: typeof events.handler) => {
            events.handler = handler;
            return events.unlisten;
        },
    }),
}));

import { i18n, setLocale } from '@/i18n';
import ComputerUseGlowView from '@/views/ComputerUseGlowView/index.vue';

beforeEach(() => {
    events.handler = undefined;
    events.unlisten.mockClear();
});

afterEach(() => vi.useRealTimers());

describe('computer use activity overlay', () => {
    it('user given foreground input when it ends before the next model round then sees no glow or operation feedback', async () => {
        const wrapper = mount(ComputerUseGlowView, { global: { plugins: [i18n] } });
        await nextTick();
        events.handler?.({
            payload: {
                generation: 1,
                activities: [{ id: 'first', ordinal: 1, pointer: { x: 240, y: 180 } }],
            },
        });
        await nextTick();
        expect(wrapper.get('[data-computer-use-frame]').isVisible()).toBe(true);
        events.handler?.({ payload: { generation: 2, activities: [] } });
        await nextTick();
        expect(wrapper.find('[data-computer-use-frame]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-status"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-pointer"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it('user given two sessions when one finishes then retains the other pointer and the stop banner', async () => {
        setLocale('zh-CN');
        const wrapper = mount(ComputerUseGlowView, { global: { plugins: [i18n] } });
        await nextTick();
        const first = { id: 'first', ordinal: 1, pointer: { x: 240, y: 180 } };
        const second = { id: 'second', ordinal: 2, pointer: { x: 600, y: 400 } };
        events.handler?.({ payload: { generation: 1, activities: [first, second] } });
        await nextTick();
        expect(wrapper.findAll('[data-testid="computer-use-pointer"]')).toHaveLength(2);
        expect(wrapper.text()).toContain('TouchAI 正在操作您的电脑');
        expect(wrapper.text()).toContain('Esc');
        expect(wrapper.text()).toContain('停止');
        events.handler?.({ payload: { generation: 2, activities: [second] } });
        await nextTick();
        expect(wrapper.findAll('[data-testid="computer-use-pointer"]')).toHaveLength(1);
        expect(wrapper.get('[data-testid="computer-use-pointer"]').attributes('style')).toContain(
            '600px'
        );
        wrapper.unmount();
    });

    it('user given stopped control when an older update arrives then keeps feedback hidden', async () => {
        const wrapper = mount(ComputerUseGlowView, { global: { plugins: [i18n] } });
        await nextTick();
        events.handler?.({ payload: { generation: 3, activities: [] } });
        events.handler?.({
            payload: {
                generation: 2,
                activities: [{ id: 'late', ordinal: 1, pointer: { x: 1, y: 2 } }],
            },
        });
        await nextTick();
        expect(wrapper.find('[data-testid="computer-use-pointer"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="computer-use-status"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it('user given a foreground operation when it is still executing then keeps the operation pointer visible', async () => {
        vi.useFakeTimers();
        const wrapper = mount(ComputerUseGlowView, { global: { plugins: [i18n] } });
        await nextTick();
        events.handler?.({
            payload: {
                generation: 1,
                activities: [{ id: 'first', ordinal: 1, pointer: { x: 240, y: 180 } }],
            },
        });
        await nextTick();
        expect(wrapper.find('[data-testid="computer-use-pointer"]').exists()).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(wrapper.find('[data-testid="computer-use-pointer"]').exists()).toBe(true);
        expect(wrapper.find('[data-computer-use-frame]').exists()).toBe(true);
        wrapper.unmount();
    });
    it('user sees the operation pointer at the delivered coordinates and clears it on the next action', async () => {
        const wrapper = mount(ComputerUseGlowView, { global: { plugins: [i18n] } });
        await nextTick();
        events.handler?.({
            payload: {
                generation: 1,
                activities: [{ id: 'first', ordinal: 1, pointer: { x: 240, y: 180 } }],
            },
        });
        await nextTick();
        expect(wrapper.get('[data-testid="computer-use-pointer"]').attributes('style')).toContain(
            'translate(240px, 180px)'
        );
        events.handler?.({
            payload: { generation: 2, activities: [{ id: 'first', ordinal: 1, pointer: null }] },
        });
        await nextTick();
        expect(wrapper.find('[data-testid="computer-use-pointer"]').exists()).toBe(false);
        wrapper.unmount();
        expect(events.unlisten).toHaveBeenCalledOnce();
    });

    it('user given English feedback when control starts then reads the app name and stop instruction without translation placeholders', async () => {
        const wrapper = mount(ComputerUseGlowView, { global: { plugins: [i18n] } });
        await nextTick();
        events.handler?.({
            payload: {
                generation: 1,
                locale: 'en-US',
                activities: [{ id: 'english', ordinal: 1, pointer: null }],
            },
        });
        await nextTick();
        const status = wrapper.get('[role="status"]');
        expect(status.text()).toContain('TouchAI is using your computer');
        expect(status.text()).toContain('Press Esc to stop');
        expect(status.text()).not.toContain('{appName}');
        wrapper.unmount();
    });
});
