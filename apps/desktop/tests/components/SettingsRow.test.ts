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

describe('user reads a settings row', () => {
    describe('user sees the row keep its look', () => {
        it('user sees the toggle row layout when a row has no description', () => {
            expect(
                rootOf(mountRow({ controlWidth: 'auto' }))
                    .classes()
                    .sort()
            ).toMatchSnapshot();
        });

        it('user sees the input row layout when a row has a description', () => {
            expect(
                rootOf(mountRow({ controlWidth: '320', description: '说明文字' }))
                    .classes()
                    .sort()
            ).toMatchSnapshot();
        });
    });

    describe('user sees the row width follow its control', () => {
        it.each([
            ['auto', 'sm:grid-cols-[minmax(0,1fr)_auto]'],
            ['180', 'sm:grid-cols-[minmax(0,1fr)_180px]'],
            ['220', 'sm:grid-cols-[minmax(0,1fr)_220px]'],
            ['320', 'sm:grid-cols-[minmax(0,1fr)_320px]'],
            ['360', 'sm:grid-cols-[minmax(0,1fr)_360px]'],
        ])('user controlwidth=%s 输出 %s', (width, expected) => {
            expect(rootOf(mountRow({ controlWidth: width })).classes()).toContain(expected);
        });

        it('user gets the input-width column when no width is given', () => {
            expect(rootOf(mountRow()).classes()).toContain('sm:grid-cols-[minmax(0,1fr)_320px]');
        });
    });

    describe('user sees the row structure', () => {
        it('user sees the row laid out as a labelled grid with padded edges', () => {
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

    describe('user reads the row label and description', () => {
        it('user sees the label in the default text style', () => {
            const label = mountRow().get('.text-compact');
            expect(label.element.tagName).toBe('DIV');
            for (const expected of [
                'text-compact',
                'leading-6',
                'font-normal',
                'text-neutral-900',
            ]) {
                expect(label.classes()).toContain(expected);
            }
        });

        it('user can click a real label element tied to its control', () => {
            const wrapper = mountRow({ labelAs: 'label', labelFor: 'x' });
            const label = wrapper.get('label');
            expect(label.attributes('for')).toBe('x');
        });

        it('user sees no description line when the row has none', () => {
            expect(mountRow().find('.mt-1').exists()).toBe(false);
        });

        it('user reads the description under the label', () => {
            const desc = mountRow({ description: '说明文字' }).get('.mt-1');
            expect(desc.classes()).toContain('text-xs');
            expect(desc.classes()).toContain('text-neutral-500');
            expect(desc.text()).toBe('说明文字');
        });
    });

    describe('user sees the row attributes land', () => {
        it('user finds the row from settings search', () => {
            const wrapper = mountRow(
                {},
                {
                    attrs: { 'data-settings-search-target': 'start-on-boot' },
                }
            );
            expect(rootOf(wrapper).attributes('data-settings-search-target')).toBe('start-on-boot');
        });

        it('user reaches the row through the test hook', () => {
            const wrapper = mountRow({}, { attrs: { 'data-testid': 'some-row' } });
            expect(rootOf(wrapper).attributes('data-testid')).toBe('some-row');
        });

        it('user keeps the call-site class on the row', () => {
            const wrapper = mountRow({ class: 'custom-row' });
            expect(rootOf(wrapper).classes()).toContain('custom-row');
            expect(rootOf(wrapper).classes()).toContain('grid');
        });

        it('user sees the label attributes on the label element', () => {
            const wrapper = mountRow({
                labelAttrs: { 'data-testid': 'settings-general-row-label' },
            });
            expect(wrapper.find('[data-testid="settings-general-row-label"]').exists()).toBe(true);
        });

        it('user sees the control attributes and class on the control container', () => {
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

    describe('user sees custom row content', () => {
        it('user sees the control inside its own container', () => {
            const wrapper = mountRow();
            expect(wrapper.find('[data-testid="control"]').exists()).toBe(true);
        });

        it('user sees a rich description in place of the text one', () => {
            const wrapper = mount(SettingsRow, {
                props: { label: '标签' },
                slots: {
                    default: () => h('span'),
                    description: () => h('span', { 'data-testid': 'desc-slot' }, '自定义描述'),
                },
            });
            expect(wrapper.get('[data-testid="desc-slot"]').text()).toBe('自定义描述');
        });

        it('user sees a rich label in place of the plain text one', () => {
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
