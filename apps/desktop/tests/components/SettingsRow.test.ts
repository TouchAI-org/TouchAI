// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * SettingsRow 的 class 快照与契约测试。
 *
 * 这个组件是 27 处手写设置行的收敛。它必须精确重现原实现的每一个 class，
 * 否则就是把重复换成了视觉偏差。因此用快照锁定三种典型形态：
 *   - 无描述的开关行（auto 宽度）
 *   - 带描述的输入行（320 宽度）
 *   - 标签为 <label> 且控件容器带额外 class 的行
 */
import SettingsRow from '@components/SettingsRow.vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { h } from 'vue';

const mountRow = (props: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    mount(SettingsRow, {
        props: { label: '标签', ...props },
        slots: { default: () => h('span', { 'data-testid': 'control' }, '控件') },
        attachTo: document.body,
        ...options,
    });

const rootOf = (wrapper: ReturnType<typeof mountRow>) => wrapper.get('div');

describe('SettingsRow', () => {
    describe('class 稳定性', () => {
        it('无描述 + auto 宽度（开关行）', () => {
            expect(
                rootOf(mountRow({ controlWidth: 'auto' }))
                    .classes()
                    .sort()
            ).toMatchSnapshot();
        });

        it('有描述 + 320 宽度（输入行）', () => {
            expect(
                rootOf(mountRow({ controlWidth: '320', description: '说明文字' }))
                    .classes()
                    .sort()
            ).toMatchSnapshot();
        });
    });

    describe('网格宽度档位', () => {
        it.each([
            ['auto', 'sm:grid-cols-[minmax(0,1fr)_auto]'],
            ['180', 'sm:grid-cols-[minmax(0,1fr)_180px]'],
            ['220', 'sm:grid-cols-[minmax(0,1fr)_220px]'],
            ['320', 'sm:grid-cols-[minmax(0,1fr)_320px]'],
            ['360', 'sm:grid-cols-[minmax(0,1fr)_360px]'],
        ])('controlWidth=%s 输出 %s', (width, expected) => {
            expect(rootOf(mountRow({ controlWidth: width })).classes()).toContain(expected);
        });

        it('默认档位是 320', () => {
            expect(rootOf(mountRow()).classes()).toContain('sm:grid-cols-[minmax(0,1fr)_320px]');
        });
    });

    describe('基础结构类', () => {
        it('根元素携带原实现的网格与内边距', () => {
            const classes = rootOf(mountRow()).classes();
            for (const expected of [
                'grid',
                'min-w-0',
                'gap-4',
                'px-5',
                'py-4',
                'sm:items-center',
            ]) {
                expect(classes).toContain(expected);
            }
        });
    });

    describe('标签与描述', () => {
        it('标签默认渲染为 div 且携带原字号', () => {
            const label = mountRow().get('.text-\\[13px\\]');
            expect(label.element.tagName).toBe('DIV');
            for (const expected of [
                'text-[13px]',
                'leading-6',
                'font-normal',
                'text-neutral-900',
            ]) {
                expect(label.classes()).toContain(expected);
            }
        });

        it('labelAs=label 时渲染为 label 元素', () => {
            const wrapper = mountRow({ labelAs: 'label', labelFor: 'x' });
            const label = wrapper.get('label');
            expect(label.attributes('for')).toBe('x');
        });

        it('无描述时不渲染描述元素', () => {
            expect(mountRow().find('.mt-1').exists()).toBe(false);
        });

        it('有描述时渲染描述元素并携带原字号与颜色', () => {
            const desc = mountRow({ description: '说明文字' }).get('.mt-1');
            expect(desc.classes()).toContain('text-xs');
            expect(desc.classes()).toContain('text-neutral-500');
            expect(desc.text()).toBe('说明文字');
        });
    });

    describe('属性透传', () => {
        it('data-settings-search-target 落在根元素上', () => {
            const wrapper = mountRow(
                {},
                {
                    attrs: { 'data-settings-search-target': 'start-on-boot' },
                }
            );
            expect(rootOf(wrapper).attributes('data-settings-search-target')).toBe('start-on-boot');
        });

        it('data-testid 落在根元素上', () => {
            const wrapper = mountRow({}, { attrs: { 'data-testid': 'some-row' } });
            expect(rootOf(wrapper).attributes('data-testid')).toBe('some-row');
        });

        it('调用点 class 与内部 class 合并而非替换', () => {
            const wrapper = mountRow({ class: 'custom-row' });
            expect(rootOf(wrapper).classes()).toContain('custom-row');
            expect(rootOf(wrapper).classes()).toContain('grid');
        });

        it('labelAttrs 落到标签元素上', () => {
            const wrapper = mountRow({
                labelAttrs: { 'data-testid': 'settings-general-row-label' },
            });
            expect(wrapper.find('[data-testid="settings-general-row-label"]').exists()).toBe(true);
        });

        it('controlAttrs 与 controlClass 落到控件容器上', () => {
            const wrapper = mountRow({
                controlAttrs: { 'data-testid': 'settings-general-control' },
                controlClass: 'ml-auto w-[180px]',
            });
            const control = wrapper.get('[data-testid="settings-general-control"]');
            expect(control.classes()).toContain('min-w-0');
            expect(control.classes()).toContain('ml-auto');
            expect(control.classes()).toContain('w-[180px]');
        });
    });

    describe('插槽', () => {
        it('默认插槽渲染在控件容器内', () => {
            const wrapper = mountRow();
            expect(wrapper.find('[data-testid="control"]').exists()).toBe(true);
        });

        it('description 插槽可替代文本描述', () => {
            const wrapper = mount(SettingsRow, {
                props: { label: '标签' },
                slots: {
                    default: () => h('span'),
                    description: () => h('span', { 'data-testid': 'desc-slot' }, '自定义描述'),
                },
            });
            expect(wrapper.get('[data-testid="desc-slot"]').text()).toBe('自定义描述');
        });

        it('label 插槽可替代纯文本标签', () => {
            const wrapper = mount(SettingsRow, {
                slots: {
                    default: () => h('span'),
                    label: () => h('span', { 'data-testid': 'label-slot' }, '富标签'),
                },
            });
            expect(wrapper.get('[data-testid="label-slot"]').text()).toBe('富标签');
        });
    });
});
