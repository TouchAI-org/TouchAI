import { useTestPrivacyWindow } from '@tests/utils/privacyWindow';

useTestPrivacyWindow();

import { webcrypto } from 'node:crypto';

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h } from 'vue';

import PrivacyAnnotatedText from '@/components/PrivacyAnnotatedText.vue';
import { usePrivacyAnnotations } from '@/composables/usePrivacyAnnotations';
import { hashPrivacyText } from '@/modules/privacy/public';

import { getTestPrivacyApi } from '../utils/privacyWindow';
const clearPrivacyReview = () => getTestPrivacyApi().clearPrivacyReview();
const publishPrivacyReview = (
    annotations: Parameters<ReturnType<typeof getTestPrivacyApi>['publishPrivacyReview']>[0]
) => getTestPrivacyApi().publishPrivacyReview(annotations);

const wrappers: ReturnType<typeof mount>[] = [];
const Harness = defineComponent({
    props: {
        messageId: { type: Number, default: undefined },
        text: { type: String, required: true },
    },
    setup(props) {
        const annotations = usePrivacyAnnotations(
            computed(() => props.messageId),
            computed(() => props.text)
        );
        return () =>
            h('div', { 'data-testid': 'message-text' }, [
                h(PrivacyAnnotatedText, { text: props.text, annotations: annotations.value }),
            ]);
    },
});
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    clearPrivacyReview();
});
afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    vi.unstubAllGlobals();
});

async function capture(text: string, messageId = 41) {
    const original = 'ada@example.test';
    const start = text.indexOf(original);
    publishPrivacyReview([
        {
            messageId,
            textHash: await hashPrivacyText(text),
            start,
            end: start + original.length,
            original,
            placeholder: '{{EMAIL_0000000000000001}}',
            kind: 'email',
            rule: { id: 'email' },
        },
    ]);
}

describe('given a user views message-scoped privacy annotations', () => {
    it('user views scanned Unicode text then only the captured original receives a marker without changing message text', async () => {
        const text = '😀请联系 ada@example.test\n后续内容';
        await capture(text);
        const wrapper = mount(Harness, { props: { messageId: 41, text } });
        wrappers.push(wrapper);
        await vi.waitFor(() =>
            expect(wrapper.findAll('[data-testid="privacy-protected-text"]')).toHaveLength(1)
        );
        expect(wrapper.get('[data-testid="message-text"]').text()).toBe(text);
    });

    it('user already sees a sent message then its marker appears when the actual replacement arrives', async () => {
        const text = 'Email ada@example.test';
        const wrapper = mount(Harness, { props: { messageId: 41, text } });
        wrappers.push(wrapper);
        await flushPromises();
        expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(false);

        await capture(text);

        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(true)
        );
        expect(wrapper.text()).toBe(text);
    });

    it('user clears review then a later protected request can annotate the still visible message again', async () => {
        const text = 'Email ada@example.test';
        await capture(text);
        const wrapper = mount(Harness, { props: { messageId: 41, text } });
        wrappers.push(wrapper);
        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(true)
        );
        clearPrivacyReview();
        await flushPromises();
        expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(false);

        await capture(text);

        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(true)
        );
    });

    it('user views an identical message with another identity then it does not claim protection', async () => {
        const text = 'Email ada@example.test';
        await capture(text);
        const wrapper = mount(Harness, { props: { messageId: 42, text } });
        wrappers.push(wrapper);
        await flushPromises();
        expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(false);
        expect(wrapper.text()).toBe(text);
    });

    it('user edits or clears a previously scanned message then its old marker disappears', async () => {
        const text = 'Email ada@example.test';
        await capture(text);
        const wrapper = mount(Harness, { props: { messageId: 41, text } });
        wrappers.push(wrapper);
        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(true)
        );
        await wrapper.setProps({ text: 'Changed: ' + text });
        expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(false);
        await wrapper.setProps({ text });
        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(true)
        );
        clearPrivacyReview();
        await flushPromises();
        expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(false);
    });

    it('user views markup-like content then it stays literal while privacy markers remain separate from source text', async () => {
        const text = '<img src=x onerror=alert(1)> ada@example.test';
        await capture(text);
        const wrapper = mount(Harness, { props: { messageId: 41, text } });
        wrappers.push(wrapper);
        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(true)
        );
        expect(wrapper.find('img').exists()).toBe(false);
        expect(wrapper.text()).toBe(text);
    });
});
