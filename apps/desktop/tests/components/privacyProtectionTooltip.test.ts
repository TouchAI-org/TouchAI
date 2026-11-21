import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';

import type { PrivacyReviewAnnotation } from '@/app/api/privacy';
import PrivacyProtectionTooltip from '@/components/PrivacyProtectionTooltip.vue';
import { setLocale } from '@/i18n';

const annotation: PrivacyReviewAnnotation = {
    messageId: 41,
    textHash: 'a'.repeat(64),
    start: 0,
    end: 16,
    original: 'ada@example.test',
    placeholder: '{{EMAIL_0000000000000001}}',
    kind: 'email',
    rule: { id: 'email' },
};
const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => setLocale('zh-CN'));
afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    document.body.innerHTML = '';
});

describe('given an actually protected text value', () => {
    it('user opens the hover then sees short detection tags the sent placeholder and protection status', async () => {
        const wrapper = mount(PrivacyProtectionTooltip, {
            props: { annotation, open: true },
            attachTo: document.body,
        });
        wrappers.push(wrapper);
        await flushPromises();
        expect(wrapper.get('[data-testid="privacy-protected-text"]').text()).toBe(
            'ada@example.test'
        );
        await vi.waitFor(() =>
            expect(
                document.querySelector('[data-testid="privacy-protection-tooltip"]')
            ).not.toBeNull()
        );
        const card = document.querySelector('[data-testid="privacy-protection-tooltip"]')!;
        expect(
            [...card.querySelectorAll('[data-testid="privacy-protection-tag"]')].map(
                (node) => node.textContent
            )
        ).toEqual(['规则', '邮箱']);
        expect(
            card.querySelector('[data-testid="privacy-protection-placeholder"]')?.textContent
        ).toBe('{{EMAIL_0000000000000001}}');
        expect(card.textContent).toContain('已本地脱敏');
        expect(card.textContent).toContain('实际发送');
        expect(card.querySelector('[data-testid="privacy-protection-shield"]')).not.toBeNull();
        expect(card.textContent).not.toContain('命中方式');
    });

    it('user taps or activates an already focused value then protection stays visible until dismissed', async () => {
        const wrapper = mount(PrivacyProtectionTooltip, {
            props: { annotation },
            attachTo: document.body,
        });
        wrappers.push(wrapper);
        const trigger = wrapper.get('[data-testid="privacy-protected-text"]');
        (trigger.element as HTMLElement).focus();
        await flushPromises();
        await vi.waitFor(() =>
            expect(
                document.querySelector('[data-testid="privacy-protection-tooltip"]')
            ).not.toBeNull()
        );

        await trigger.trigger('click');
        await flushPromises();
        expect(document.querySelector('[data-testid="privacy-protection-tooltip"]')).not.toBeNull();
        await trigger.trigger('keydown', { key: 'Enter' });
        await flushPromises();
        expect(document.querySelector('[data-testid="privacy-protection-tooltip"]')).not.toBeNull();
        await trigger.trigger('keydown', { key: ' ' });
        await flushPromises();
        expect(document.querySelector('[data-testid="privacy-protection-tooltip"]')).not.toBeNull();

        await trigger.trigger('keydown', { key: 'Escape' });
        await flushPromises();
        expect(document.querySelector('[data-testid="privacy-protection-tooltip"]')).toBeNull();
    });

    it('user dismisses a focused privacy tooltip then the surrounding conversation stays open', async () => {
        const Conversation = defineComponent({
            setup() {
                const closed = ref(false);
                return () =>
                    h(
                        'main',
                        {
                            onKeydown: (event: KeyboardEvent) => {
                                if (event.key === 'Escape') closed.value = true;
                            },
                        },
                        closed.value
                            ? 'Conversation closed'
                            : h(PrivacyProtectionTooltip, { annotation })
                    );
            },
        });
        const wrapper = mount(Conversation, { attachTo: document.body });
        wrappers.push(wrapper);
        const trigger = wrapper.get('[data-testid="privacy-protected-text"]');
        (trigger.element as HTMLElement).focus();
        await vi.waitFor(() =>
            expect(
                document.querySelector('[data-testid="privacy-protection-tooltip"]')
            ).not.toBeNull()
        );

        await trigger.trigger('keydown', { key: 'Escape' });
        await flushPromises();

        expect(wrapper.text()).toBe(annotation.original);
        expect(document.querySelector('[data-testid="privacy-protection-tooltip"]')).toBeNull();
    });

    it('user reviews a model hit then sees the detection method and entity as short labels', async () => {
        const wrapper = mount(PrivacyProtectionTooltip, {
            props: {
                annotation: {
                    ...annotation,
                    kind: 'privatePerson',
                    rule: { id: 'localModel', modelId: 'astrlink-guard-int8' },
                },
                open: true,
            },
            attachTo: document.body,
        });
        wrappers.push(wrapper);
        await flushPromises();
        await vi.waitFor(() =>
            expect(
                document.querySelector('[data-testid="privacy-protection-tooltip"]')
            ).not.toBeNull()
        );
        const tags = [...document.querySelectorAll('[data-testid="privacy-protection-tag"]')].map(
            (node) => node.textContent
        );
        expect(tags).toEqual(['模型', '姓名']);
    });

    it('user views markup-like original text then it remains literal and closing unmounts the floating content', async () => {
        const wrapper = mount(PrivacyProtectionTooltip, {
            props: {
                annotation: {
                    ...annotation,
                    original: '<img src=x onerror=alert(1)>',
                    kind: 'custom',
                    rule: { id: 'customWord', value: 'test' },
                },
                open: true,
            },
            attachTo: document.body,
        });
        wrappers.push(wrapper);
        await flushPromises();
        await vi.waitFor(() =>
            expect(
                document.querySelector('[data-testid="privacy-protection-tooltip"]')
            ).not.toBeNull()
        );
        expect(
            [...document.querySelectorAll('[data-testid="privacy-protection-tag"]')].map(
                (node) => node.textContent
            )
        ).toEqual(['自定义', '词语']);
        expect(wrapper.find('img').exists()).toBe(false);
        expect(wrapper.get('[data-testid="privacy-protected-text"]').text()).toContain('<img');
        await wrapper.setProps({ open: false });
        await flushPromises();
        expect(document.querySelector('[data-testid="privacy-protection-tooltip"]')).toBeNull();
    });

    it('user switches interface language then the protection explanation follows the locale without changing the placeholder', async () => {
        setLocale('en-US');
        const wrapper = mount(PrivacyProtectionTooltip, {
            props: { annotation, open: true },
            attachTo: document.body,
        });
        wrappers.push(wrapper);
        await flushPromises();
        await vi.waitFor(() =>
            expect(
                document.querySelector('[data-testid="privacy-protection-tooltip"]')
            ).not.toBeNull()
        );
        const card = document.querySelector('[data-testid="privacy-protection-tooltip"]')!;
        expect(card.textContent).toContain('Rules');
        expect(card.textContent).toContain('Locally protected');
        expect(card.textContent).toContain('Actually sent');
        expect(card.textContent).toContain('{{EMAIL_0000000000000001}}');
    });
});
