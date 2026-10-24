// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/Dialog 的样式契约。
 *
 * 这一组原语此前没有任何测试（审计发现 34 个 ui 组件中 24 个裸奔），而 dialog
 * 是最常被调用的弹层之一。写这组测试时发现了一个真实缺口，记录在这里而不是
 * 用断言掩盖过去：
 *
 *   `ui/dialog` 的 DialogContent 只负责定位（居中、fixed、z-50），不含任何卡片
 *   表面样式（圆角、边框、背景、内边距、阴影）。这些全部由调用点提供，例如
 *   DialogShell 自己拼了一串 `rounded-xl border border-gray-200 bg-white p-6
 *   font-serif shadow-xl`。也就是说，直接使用 DialogContent 的调用点会得到一个
 *   没有外观的浮层。
 *
 * 这属于阶段 3 的原语收敛工作：要么把表面样式收进原语，要么把 DialogShell 的
 * 那段样式提成正式的 variant。在那之前，本测试锁定「现状确实如此」，避免有人
 * 误以为原语自带卡片外观。
 *
 * 另外两件事在这里锁定：
 *   1. 遮罩与卡片分别带 `t-overlay` / `t-modal`，这是 Reka 识别退出动画的依据；
 *   2. 不用 `animate-in`，Reka 检测不到它的退出。
 */
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@components/ui/dialog';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * Dialog portals into document.body and does not unmount its content between
 * tests, so a stale card from an earlier case would otherwise be the first
 * `[role="dialog"]` a later case finds.
 */
afterEach(() => {
    document.body.innerHTML = '';
});

function mountDialog(contentClass = '', overlayClass = '') {
    return mount(
        {
            components: {
                Dialog,
                DialogContent,
                DialogHeader,
                DialogTitle,
                DialogDescription,
                DialogFooter,
            },
            data: () => ({ contentClass, overlayClass }),
            template: `
                <Dialog :open="true">
                    <DialogContent :class="contentClass" :overlay-class="overlayClass" force-mount>
                        <DialogHeader>
                            <DialogTitle>标题</DialogTitle>
                            <DialogDescription>描述</DialogDescription>
                        </DialogHeader>
                        <p>正文</p>
                        <DialogFooter>footer</DialogFooter>
                    </DialogContent>
                </Dialog>
            `,
        },
        { attachTo: document.body }
    );
}

function dialogCard(): Element {
    const card = document.querySelector('[role="dialog"]');
    expect(card, 'dialog content was not rendered').not.toBeNull();
    return card as Element;
}

function cardClasses(): string[] {
    return Array.from(dialogCard().classList);
}

describe('ui/Dialog presence hooks', () => {
    it('renders the card with the t-modal hook', async () => {
        mountDialog();
        await flushPromises();

        expect(cardClasses()).toContain('t-modal');
    });

    it('renders the overlay with the t-overlay hook', async () => {
        mountDialog();
        await flushPromises();

        // The overlay is the sibling that Reka renders before the card; it carries
        // the same fixed/z-50 positioning as the card, so find it by exclusion.
        const overlays = Array.from(document.querySelectorAll('div')).filter((element) =>
            element.classList.contains('t-overlay')
        );

        expect(overlays.length, 'no element carries t-overlay').toBeGreaterThan(0);
    });

    it('does not rely on animate-in, which Reka cannot detect for exit', async () => {
        mountDialog();
        await flushPromises();

        expect(cardClasses().join(' ')).not.toContain('animate-in');
    });

    it('positions the card without supplying a surface', async () => {
        mountDialog();
        await flushPromises();

        const classes = cardClasses();

        // Positioning is the primitive's job.
        expect(classes).toContain('fixed');
        expect(classes).toContain('z-50');
        expect(classes).toContain('grid');

        // The surface is not. This is the documented gap: call sites such as
        // DialogShell add rounded-xl / border / bg-white / p-6 / shadow-xl.
        for (const absent of ['rounded-xl', 'bg-white', 'shadow-xl', 'p-6']) {
            expect(
                classes,
                `${absent} should come from the call site, not the primitive`
            ).not.toContain(absent);
        }
    });

    it('passes a call-site surface through', async () => {
        mountDialog('rounded-xl border border-gray-200 bg-white p-6 shadow-xl');
        await flushPromises();

        const classes = cardClasses();
        for (const expected of ['rounded-xl', 'bg-white', 'p-6', 'shadow-xl']) {
            expect(classes, `call-site class ${expected} was dropped`).toContain(expected);
        }
    });

    it('lets the call site override the overlay class', async () => {
        mountDialog('', 'bg-black/60');
        await flushPromises();

        const overlays = Array.from(document.querySelectorAll('div')).filter((element) =>
            element.classList.contains('t-overlay')
        );

        expect(overlays.some((element) => element.classList.contains('bg-black/60'))).toBe(true);
    });

    it('renders header, body and footer content', async () => {
        mountDialog();
        await flushPromises();

        const text = dialogCard().textContent ?? '';
        expect(text).toContain('标题');
        expect(text).toContain('描述');
        expect(text).toContain('正文');
        expect(text).toContain('footer');
    });
});

describe('ui/Dialog layout primitives', () => {
    it('DialogHeader stacks its children vertically', async () => {
        mountDialog();
        await flushPromises();

        const header = dialogCard().querySelector('.flex-col');
        expect(header, 'header did not render flex-col').not.toBeNull();
        expect(Array.from(header?.classList ?? [])).toContain('gap-1.5');
    });

    it('DialogFooter lays its children out in a row', async () => {
        mountDialog();
        await flushPromises();

        const footer = Array.from(dialogCard().querySelectorAll('div')).find((element) =>
            element.classList.contains('gap-3')
        );

        expect(footer, 'footer did not render gap-3').not.toBeNull();
        expect(Array.from(footer?.classList ?? [])).toContain('flex');
    });

    it('DialogTitle keeps the serif display face', async () => {
        mountDialog();
        await flushPromises();

        const title = dialogCard().querySelector('h2');
        expect(title, 'title did not render as h2').not.toBeNull();

        const classes = Array.from(title?.classList ?? []);
        expect(classes).toContain('font-serif');
        expect(classes).toContain('font-semibold');
    });

    it('DialogDescription uses the muted body colour', async () => {
        mountDialog();
        await flushPromises();

        const description = dialogCard().querySelector('p');
        expect(description, 'description did not render as p').not.toBeNull();

        const classes = Array.from(description?.classList ?? []);
        expect(classes).toContain('text-sm');
        expect(classes).toContain('text-gray-600');
    });

    it('layout primitives accept a call-site class', async () => {
        const wrapper = mount(DialogFooter, {
            props: { class: 'justify-end' },
            slots: { default: 'footer' },
        });

        expect(wrapper.classes()).toContain('justify-end');
    });
});
