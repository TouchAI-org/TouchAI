import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import UpdateDetailsDialog from '@/views/SettingsView/components/General/UpdateDetailsDialog.vue';

enableAutoUnmount((unmount) => {
    afterEach(() => {
        unmount();
        setLocale('zh-CN');
        document.body.innerHTML = '';
    });
});

async function mountDialog(downloadProgress?: number | null, busy = true) {
    const wrapper = mount(UpdateDetailsDialog, {
        attachTo: document.body,
        props: {
            title: 'Version update',
            version: '0.3.0',
            channel: 'Beta',
            hasUpdate: true,
            releaseNotes: '',
            actionText: 'Update now',
            busy,
            downloadProgress,
        },
    });
    await flushPromises();
    return wrapper;
}

function dialog() {
    return new DOMWrapper(document.body).get('[data-testid="settings-update-details-dialog"]');
}

describe.each([
    { locale: 'zh-CN', backgroundLabel: '后台继续', cancelLabel: '取消' },
    { locale: 'en-US', backgroundLabel: 'Continue in background', cancelLabel: 'Cancel' },
] as const)('user manages an update in $locale', ({ locale, backgroundLabel, cancelLabel }) => {
    it.each([0, 40, 100])(
        'user closes a download at %i percent with a background action instead of cancellation',
        async (progress) => {
            setLocale(locale);
            const wrapper = await mountDialog(progress);
            const dismissButton = dialog().get('footer button');

            expect(dismissButton.text()).toBe(backgroundLabel);
            expect(dialog().get('[role="progressbar"]').attributes('aria-valuenow')).toBe(
                String(progress)
            );
            expect(
                dialog()
                    .get('[data-testid="settings-update-dialog-primary"]')
                    .attributes('disabled')
            ).toBeDefined();

            await dismissButton.trigger('click');

            expect(wrapper.emitted('close')).toEqual([[]]);
            expect(wrapper.emitted('action')).toBeUndefined();
        }
    );

    it.each([null, undefined])(
        'user dismisses an idle update prompt with the existing cancel action when progress is %s',
        async (progress) => {
            setLocale(locale);
            const wrapper = await mountDialog(progress, false);
            const dismissButton = dialog().get('footer button');

            expect(dismissButton.text()).toBe(cancelLabel);
            expect(dialog().find('[role="progressbar"]').exists()).toBe(false);

            await dismissButton.trigger('click');

            expect(wrapper.emitted('close')).toEqual([[]]);
            expect(wrapper.emitted('action')).toBeUndefined();
        }
    );

    it('user does not see a background download action during installation', async () => {
        setLocale(locale);
        await mountDialog(null);

        expect(dialog().get('footer button').text()).toBe(cancelLabel);
        expect(
            dialog().get('[data-testid="settings-update-dialog-primary"]').attributes('disabled')
        ).toBeDefined();
    });
});

it('user sees the background action translated when switching language during a download', async () => {
    setLocale('zh-CN');
    await mountDialog(25);
    expect(dialog().get('footer button').text()).toBe('后台继续');

    setLocale('en-US');
    await flushPromises();

    expect(dialog().get('footer button').text()).toBe('Continue in background');
});
