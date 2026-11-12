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

it('user reads the current release notes without an installation action', async () => {
    setLocale('en-US');
    const wrapper = await mountDialog(null, false);
    await wrapper.setProps({ hasUpdate: false, releaseNotes: 'Safer updates in this version' });
    await flushPromises();
    expect(dialog().text()).toContain('Safer updates in this version');
    await dialog().get('[data-testid="settings-update-dialog-primary"]').trigger('click');
    expect(wrapper.emitted('close')).toEqual([[]]);
    expect(wrapper.emitted('action')).toBeUndefined();
});

it('user sees version headings only when several releases are combined', async () => {
    setLocale('en-US');
    const wrapper = await mountDialog(null, false);
    await wrapper.setProps({
        hasUpdate: false,
        releaseNotes: '',
        releaseSections: [
            {
                version: '1.3.0-beta.3',
                publishedAt: '2026-11-12T10:20:04Z',
                notes: 'Current release notes',
            },
            {
                version: '1.3.0-beta.2',
                publishedAt: '2026-11-10T10:20:04Z',
                notes: 'Previous release notes',
            },
        ],
    });
    await flushPromises();

    const headings = dialog().findAll('h1');
    expect(headings.map((heading) => heading.text())).toEqual([
        'V1.3.0-beta.3 · Nov 12, 2026',
        'V1.3.0-beta.2 · Nov 10, 2026',
    ]);
    expect(dialog().text()).not.toContain('Changelog');

    await wrapper.setProps({
        releaseSections: [
            {
                version: '1.3.0-beta.3',
                publishedAt: '2026-11-12T10:20:04Z',
                notes: 'Current release notes',
            },
        ],
    });
    await flushPromises();

    expect(dialog().findAll('h1')).toHaveLength(0);
});

it.each([
    { bytes: 10, expected: '10 byte' },
    { bytes: 12_000, expected: '12 kB' },
    { bytes: 12_000_000, expected: '12 MB' },
    { bytes: 1_500_000_000, expected: '1.5 GB' },
])(
    'user sees a nonzero declared package size for $bytes bytes without an invented transfer estimate',
    async ({ bytes, expected }) => {
        setLocale('en-US');
        const wrapper = await mountDialog(null, false);
        await wrapper.setProps({ packageSizeBytes: bytes });
        expect(dialog().text()).toContain(expected);
        await wrapper.setProps({ packageSizeBytes: null });
        expect(dialog().text()).not.toContain(expected);
    }
);
