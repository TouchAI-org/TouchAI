// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/AlertDialog 的样式契约。
 *
 * 此前零覆盖（24/34 个 ui 组件无测试）。AlertDialog 只被 ConfirmDialog 使用，
 * 但它是破坏性操作唯一的确认通道，样式漂移的代价高，所以单独锁住。
 *
 * 关注点与 dialog 相同：presence 钩子、动作按钮的视觉层级、以及调用点覆盖。
 */
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@components/ui/alert-dialog';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
    document.body.innerHTML = '';
});

function mountConfirmDialog() {
    return mount(
        {
            components: {
                AlertDialog,
                AlertDialogContent,
                AlertDialogHeader,
                AlertDialogTitle,
                AlertDialogDescription,
                AlertDialogFooter,
                AlertDialogAction,
                AlertDialogCancel,
            },
            template: `
                <AlertDialog :open="true">
                    <AlertDialogContent force-mount>
                        <AlertDialogHeader>
                            <AlertDialogTitle>删除会话</AlertDialogTitle>
                            <AlertDialogDescription>此操作不可撤销</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction>删除</AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            `,
        },
        { attachTo: document.body }
    );
}

function content(): Element {
    const element = document.querySelector('[role="alertdialog"]');
    expect(element, 'alert dialog content was not rendered').not.toBeNull();
    return element as Element;
}

function classesOf(element: Element | null): string[] {
    return Array.from(element?.classList ?? []);
}

describe('ui/AlertDialog', () => {
    it('renders with the t-modal presence hook', async () => {
        mountConfirmDialog();
        await flushPromises();

        expect(classesOf(content())).toContain('t-modal');
    });

    it('renders an overlay carrying t-overlay', async () => {
        mountConfirmDialog();
        await flushPromises();

        const overlays = Array.from(document.querySelectorAll('div')).filter((element) =>
            element.classList.contains('t-overlay')
        );

        expect(overlays.length).toBeGreaterThan(0);
    });

    it('does not rely on animate-in', async () => {
        mountConfirmDialog();
        await flushPromises();

        expect(classesOf(content()).join(' ')).not.toContain('animate-in');
    });

    it('renders the title, description and both actions', async () => {
        mountConfirmDialog();
        await flushPromises();

        const text = content().textContent ?? '';
        expect(text).toContain('删除会话');
        expect(text).toContain('此操作不可撤销');
        expect(text).toContain('取消');
        expect(text).toContain('删除');
    });

    it('gives the confirm action the filled treatment', async () => {
        mountConfirmDialog();
        await flushPromises();

        const buttons = Array.from(content().querySelectorAll('button'));
        const confirm = buttons.find((button) => button.textContent?.includes('删除'));

        expect(confirm, 'confirm action missing').toBeDefined();

        const classes = classesOf(confirm ?? null);
        expect(classes).toContain('t-press');
        expect(classes).toContain('text-white');
        expect(classes).toContain('rounded-lg');
    });

    it('gives the cancel action the outlined treatment', async () => {
        mountConfirmDialog();
        await flushPromises();

        const buttons = Array.from(content().querySelectorAll('button'));
        const cancel = buttons.find((button) => button.textContent?.includes('取消'));

        expect(cancel, 'cancel action missing').toBeDefined();

        const classes = classesOf(cancel ?? null);
        expect(classes).toContain('border');
        expect(classes).toContain('border-gray-200');
        expect(classes).not.toContain('text-white');
    });

    it('keeps both actions equal width so the footer balances', async () => {
        mountConfirmDialog();
        await flushPromises();

        for (const button of Array.from(content().querySelectorAll('button'))) {
            expect(classesOf(button)).toContain('flex-1');
        }
    });

    it('renders the title in the serif display face', async () => {
        mountConfirmDialog();
        await flushPromises();

        const title = content().querySelector('h2');
        expect(title, 'title did not render as h2').not.toBeNull();
        expect(classesOf(title)).toContain('font-serif');
    });

    it('accepts a call-site class on the content', async () => {
        mount(
            {
                components: { AlertDialog, AlertDialogContent },
                template: `
                    <AlertDialog :open="true">
                        <AlertDialogContent class="max-w-sm" force-mount>正文</AlertDialogContent>
                    </AlertDialog>
                `,
            },
            { attachTo: document.body }
        );
        await flushPromises();

        expect(classesOf(content())).toContain('max-w-sm');
    });

    it('stacks the header vertically and the footer in a row', async () => {
        mountConfirmDialog();
        await flushPromises();

        const header = content().querySelector('.flex-col');
        expect(header, 'header missing flex-col').not.toBeNull();

        const footer = Array.from(content().querySelectorAll('div')).find((element) =>
            element.classList.contains('gap-3')
        );
        expect(footer, 'footer missing gap-3').not.toBeNull();
    });
});
