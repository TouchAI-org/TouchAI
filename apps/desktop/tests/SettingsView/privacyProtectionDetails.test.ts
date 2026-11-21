import type { InvokeArgs } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { useTestPrivacyWindow } from '@tests/utils/privacyWindow';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type {
    PrivacyProtectionDetails,
    PrivacyProtectionRecord,
} from '@/platform/native/privacyFilter';
import PrivacyProtectionDetailsView from '@/views/SettingsView/components/PrivacyFilter/PrivacyProtectionDetails.vue';
import PrivacyProtectionRecords from '@/views/SettingsView/components/PrivacyFilter/PrivacyProtectionRecords.vue';

import { mockTauriCommand } from '../utils/tauri';

useTestPrivacyWindow();
enableAutoUnmount(afterEach);

const record: PrivacyProtectionRecord = {
    id: 'request-1',
    createdAt: Date.UTC(2026, 10, 14, 12),
    mode: 'rules',
    outcome: 'protected',
    maskedCount: 1,
    categories: [{ kind: 'email', count: 1 }],
};

function snapshot(
    original = 'ada@example.test',
    placeholder = '{{EMAIL_0123456789abcdef}}'
): PrivacyProtectionDetails {
    return {
        values: [
            {
                kind: 'email',
                original,
                placeholder,
                count: 1,
                matches: [{ id: 'email', count: 1 }],
            },
        ],
        texts: [],
        truncated: false,
    };
}

beforeEach(() => {
    setLocale('zh-CN');
    mockTauriCommand('privacy_filter_record_details', snapshot());
    mockTauriCommand('privacy_filter_records', [{ ...record, createdAt: Date.now() }]);
    mockTauriCommand('privacy_filter_record_detail_ids', ['request-1', 'request-2']);
});

describe('given the user expands a memory-only replacement list', () => {
    it('user opens several long context texts then sees ordered compact pairs without fragment headings or context controls', async () => {
        const details = snapshot();
        const placeholder = details.values[0]!.placeholder;
        const firstBackground = '第一段背景只用于复核完整上下文。'.repeat(80);
        const secondBackground = '另一轮的非关键资料暂时不需要显示。'.repeat(80);
        details.texts = [
            `${firstBackground}\n\n请使用 ${placeholder} 联系。\n\n这里是完全无关的附录。`,
            `${secondBackground}\n\n第二段确认 ${placeholder} 已收件。`,
        ];
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        const fragments = wrapper.findAll('[data-testid="privacy-protection-context"]');
        expect(fragments).toHaveLength(2);
        expect(wrapper.text()).not.toContain('片段');
        expect(wrapper.text()).not.toContain('展开上下文');
        expect(wrapper.text()).not.toContain('收起上下文');
        for (const fragment of fragments) {
            expect(fragment.findAll('[data-testid="privacy-protection-stage"]')).toHaveLength(2);
            expect(fragment.text()).toContain('…');
            expect(fragment.find('button').exists()).toBe(false);
        }
        expect(fragments[0]!.text()).toContain('请使用');
        expect(fragments[1]!.text()).toContain('第二段确认');
        expect(wrapper.text()).not.toContain(firstBackground);
        expect(wrapper.text()).not.toContain(secondBackground);
        expect(wrapper.text()).not.toContain('完全无关的附录');
        expect(wrapper.findAll('[data-testid="privacy-protection-value-original"]')).toHaveLength(
            2
        );
    });

    it('user opens distant replacements in one very long paragraph then sees both keywords in one pair of cells with an ellipsis between them', async () => {
        const details = snapshot();
        const email = details.values[0]!;
        const phone = {
            kind: 'phone' as const,
            original: '202-555-0138',
            placeholder: '{{PHONE_0123456789abcdef}}',
            count: 1,
        };
        details.values.push(phone);
        const background = '很长的常规内容与此次敏感信息没有直接关系。'.repeat(120);
        details.texts = [
            `${background}邮箱为 ${email.placeholder}。${background}电话为 ${phone.placeholder}。${background}`,
        ];
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        const panes = wrapper.findAll('[data-testid="privacy-protection-stage"]');
        expect(panes).toHaveLength(2);
        expect(wrapper.text()).not.toContain(background);
        expect(wrapper.text().length).toBeLessThan(700);
        expect(
            wrapper
                .findAll('[data-testid="privacy-protection-value-original"]')
                .map((value) => value.text())
        ).toEqual([email.original, phone.original]);
        expect(
            wrapper
                .findAll('[data-testid="privacy-protection-value-masked"]')
                .map((value) => value.text())
        ).toEqual([email.placeholder, phone.placeholder]);
        for (const [paneIndex, side] of ['original', 'placeholder'].entries()) {
            const text = panes[paneIndex]!.text();
            const first = side === 'original' ? email.original : email.placeholder;
            const last = side === 'original' ? phone.original : phone.placeholder;
            const between = text.slice(text.indexOf(first) + first.length, text.indexOf(last));
            expect(between.match(/…/g)).toHaveLength(1);
        }
    });

    it('user opens sensitive paragraphs separated by background then sees an omission inside the same pair of cells', async () => {
        const details = snapshot();
        const email = details.values[0]!;
        const background = '这段常规背景可以在复核时展开。';
        details.texts = [
            `首次联系 ${email.placeholder}。\n\n${background}\n还有一段无需展示的背景。\n\n再次确认 ${email.placeholder}。`,
        ];
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        const panes = wrapper.findAll('[data-testid="privacy-protection-stage"]');
        expect(panes).toHaveLength(2);
        for (const [index, value] of [email.original, email.placeholder].entries()) {
            const text = panes[index]!.text();
            expect(text).toContain(`首次联系 ${value}。`);
            expect(text).toContain(`再次确认 ${value}。`);
            expect(text.match(/…/g)).toHaveLength(1);
            expect(text).not.toContain(background);
        }
    });

    it('user reads a partially retained request then sees the available replacements without a separate retention notice', async () => {
        const details = snapshot();
        details.values.push({
            kind: 'phone',
            original: '202-555-0138',
            placeholder: '{{PHONE_0123456789abcdef}}',
            count: 1,
        });
        details.texts = [`保留的邮箱上下文 ${details.values[0]!.placeholder}`];
        details.truncated = true;
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="privacy-protection-value-original"]')
                .map((value) => value.text())
        ).toEqual(['ada@example.test', '202-555-0138']);
        expect(wrapper.text()).not.toContain('部分内容未保留');
    });

    it('user reviews long Unicode context then shortened excerpts keep whole graphemes and exact restored values', async () => {
        const details = snapshot();
        const emoji = '🧑🏽‍💻';
        details.texts = [
            `${emoji.repeat(160)}联系 ${details.values[0]!.placeholder}${emoji.repeat(160)}`,
        ];
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, {
            props: { record: { ...record, direction: 'restore' } },
        });
        await flushPromises();
        expect(wrapper.text()).not.toContain(emoji.repeat(160));
        expect(wrapper.text()).toContain(emoji.repeat(40));
        expect(wrapper.text()).not.toMatch(
            /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
        );
        const panes = wrapper.findAll('[data-testid="privacy-protection-stage"]');
        expect(panes[0]!.text()).toContain(details.values[0]!.placeholder);
        expect(panes[1]!.text()).toContain(details.values[0]!.original);
    });

    it('user opens an inline record then sees two labelled stages and highlighted counterparts without a modal or another reveal step', async () => {
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="privacy-protection-stage-label"]')
                .map((header) => header.text())
        ).toEqual(['脱敏前', '脱敏后']);
        expect(wrapper.get('[data-testid="privacy-protection-value-original"]').text()).toBe(
            'ada@example.test'
        );
        expect(wrapper.get('[data-testid="privacy-protection-value-masked"]').text()).toBe(
            '{{EMAIL_0123456789abcdef}}'
        );
        expect(wrapper.findAll('[data-testid="privacy-protection-stage"]')).toHaveLength(2);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(wrapper.find('[data-testid="privacy-protection-value-reveal"]').exists()).toBe(
            false
        );
        expect(wrapper.find('[data-testid="privacy-protection-details-view"]').exists()).toBe(
            false
        );
    });

    it('user changes the selected request while its values load then only the new request can appear', async () => {
        let finishFirst!: (value: PrivacyProtectionDetails) => void;
        const first = new Promise<PrivacyProtectionDetails>((resolve) => {
            finishFirst = resolve;
        });
        mockTauriCommand('privacy_filter_record_details', (payload?: InvokeArgs) =>
            (payload as { recordId: string }).recordId === record.id
                ? first
                : snapshot('bob@example.test', '{{EMAIL_fedcba9876543210}}')
        );
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        expect(wrapper.text()).toContain('加载中');
        await wrapper.setProps({ record: { ...record, id: 'request-2' } });
        await flushPromises();
        expect(wrapper.text()).toContain('bob@example.test');
        finishFirst(snapshot());
        await flushPromises();
        expect(wrapper.text()).toContain('bob@example.test');
        expect(wrapper.text()).not.toContain('ada@example.test');
    });

    it('user collapses a loading row then a late result cannot revive any original value', async () => {
        let finish!: (value: PrivacyProtectionDetails) => void;
        mockTauriCommand(
            'privacy_filter_record_details',
            new Promise<PrivacyProtectionDetails>((resolve) => {
                finish = resolve;
            })
        );
        const wrapper = mount(PrivacyProtectionRecords, {
            props: { disabled: false },
            attachTo: document.body,
        });
        await flushPromises();
        const action = wrapper.get('[data-testid="privacy-protection-record-open"]');
        await action.trigger('click');
        await flushPromises();
        await action.trigger('click');
        await flushPromises();
        finish(snapshot());
        await flushPromises();
        expect(wrapper.find('[data-testid="privacy-protection-details"]').exists()).toBe(false);
        expect(document.body.textContent).not.toContain('ada@example.test');
        expect(action.attributes('aria-expanded')).toBe('false');
    });

    it('user opens another row then the previous list collapses instead of retaining multiple sets of originals', async () => {
        mockTauriCommand('privacy_filter_records', [
            { ...record, createdAt: Date.now() },
            { ...record, id: 'request-2', createdAt: Date.now() },
        ]);
        mockTauriCommand('privacy_filter_record_details', (payload?: InvokeArgs) =>
            snapshot(
                (payload as { recordId: string }).recordId === 'request-1'
                    ? 'ada@example.test'
                    : 'bob@example.test'
            )
        );
        const wrapper = mount(PrivacyProtectionRecords, { props: { disabled: false } });
        await flushPromises();
        const rows = wrapper.findAll('[data-testid="privacy-protection-record"]');
        await rows[0]!.get('[data-testid="privacy-protection-record-open"]').trigger('click');
        await flushPromises();
        await rows[1]!.get('[data-testid="privacy-protection-record-open"]').trigger('click');
        await flushPromises();
        expect(wrapper.findAll('[data-testid="privacy-protection-details"]')).toHaveLength(1);
        expect(rows[0]!.find('[data-testid="privacy-protection-details"]').exists()).toBe(false);
        expect(rows[1]!.text()).toContain('bob@example.test');
        expect(wrapper.text()).not.toContain('ada@example.test');
    });

    it('user sees records cleared in another window then the expanded original values are removed with their row', async () => {
        let records = [{ ...record, createdAt: Date.now() }];
        mockTauriCommand('privacy_filter_records', () => records);
        const wrapper = mount(PrivacyProtectionRecords, {
            props: { disabled: false },
            attachTo: document.body,
        });
        await flushPromises();
        await wrapper.get('[data-testid="privacy-protection-record-open"]').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('ada@example.test');
        records = [];
        await emit('privacy-filter-records-changed', null);
        await flushPromises();
        expect(wrapper.find('[data-testid="privacy-protection-details"]').exists()).toBe(false);
        expect(document.body.textContent).not.toContain('ada@example.test');
        expect(wrapper.text()).toContain('暂无保护记录');
    });

    it('user disables protection while a list is open then it collapses and all row actions are disabled', async () => {
        const wrapper = mount(PrivacyProtectionRecords, {
            props: { disabled: false },
            attachTo: document.body,
        });
        await flushPromises();
        await wrapper.get('[data-testid="privacy-protection-record-open"]').trigger('click');
        await flushPromises();
        await wrapper.setProps({ disabled: true });
        await flushPromises();
        expect(document.body.textContent).not.toContain('ada@example.test');
        expect(wrapper.find('[data-testid="privacy-protection-details"]').exists()).toBe(false);
        expect(
            wrapper.get<HTMLButtonElement>('[data-testid="privacy-protection-record-open"]').element
                .disabled
        ).toBe(true);
    });

    it('user expands values containing markup then reads plain text without executing that markup', async () => {
        const original = '<img src=x onerror="alert(1)">';
        mockTauriCommand('privacy_filter_record_details', snapshot(original));
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        expect(wrapper.text()).toContain(original);
        expect(wrapper.find('img').exists()).toBe(false);
    });

    it('user expands many replacements then all retained counterparts are immediately available without another display control', async () => {
        const details: PrivacyProtectionDetails = {
            values: Array.from({ length: 25 }, (_, index) => ({
                kind: 'email',
                original: `user${index}@example.test`,
                placeholder: `{{EMAIL_${index.toString(16).padStart(16, '0')}}}`,
                count: 1,
                matches: [{ id: 'email', count: 1 }],
            })),
            texts: [],
            truncated: false,
        };
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, {
            props: {
                record: { ...record, maskedCount: 25, categories: [{ kind: 'email', count: 25 }] },
            },
        });
        await flushPromises();
        expect(wrapper.findAll('[data-testid="privacy-protection-value-original"]')).toHaveLength(
            25
        );
        expect(wrapper.findAll('[data-testid="privacy-protection-value-masked"]')).toHaveLength(25);
        expect(wrapper.find('[data-testid="privacy-protection-values-more"]').exists()).toBe(false);
    });

    it('user expands a blocked request then sees that it was not sent instead of fabricated replacement values', async () => {
        mockTauriCommand('privacy_filter_record_details', null);
        const wrapper = mount(PrivacyProtectionDetailsView, {
            props: { record: { ...record, outcome: 'blocked', maskedCount: 0, categories: [] } },
        });
        await flushPromises();
        expect(wrapper.text()).toContain('未发送给模型');
        expect(wrapper.find('[data-testid="privacy-protection-value"]').exists()).toBe(false);
    });

    it('user reads custom and model replacements then their exact original values remain marked without long rule descriptions', async () => {
        mockTauriCommand('privacy_filter_record_details', {
            values: [
                {
                    kind: 'custom',
                    original: 'company_token_test',
                    placeholder: '{{CUSTOM_0123456789abcdef}}',
                    count: 1,
                    matches: [{ id: 'customPrefix', value: 'company_token_', count: 1 }],
                },
                {
                    kind: 'custom',
                    original: 'Project Nightfall',
                    placeholder: '{{TERM_0123456789abcdef}}',
                    count: 1,
                    matches: [{ id: 'customWord', value: 'Project Nightfall', count: 1 }],
                },
                {
                    kind: 'privatePerson',
                    original: ['Morgan', 'Lee'].join(' '),
                    placeholder: '{{PERSON_0123456789abcdef}}',
                    count: 1,
                    matches: [{ id: 'localModel', modelId: 'astrlink-guard-int8', count: 1 }],
                },
            ],
            texts: [],
            truncated: false,
        });
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="privacy-protection-value-original"]')
                .map((value) => value.text())
        ).toEqual(['company_token_test', 'Project Nightfall', ['Morgan', 'Lee'].join(' ')]);
        expect(wrapper.text()).not.toContain('AstrLink Guard INT8');
    });

    it('user expands one value found by multiple sources then it appears once per side without duplicate rule rows', async () => {
        const details = snapshot();
        details.values[0]!.count = 3;
        details.values[0]!.matches = [
            { id: 'email', count: 2 },
            { id: 'localModel', modelId: 'astrlink-guard-int8', count: 1 },
        ];
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        expect(wrapper.findAll('[data-testid="privacy-protection-value-original"]')).toHaveLength(
            1
        );
        expect(wrapper.findAll('[data-testid="privacy-protection-value-masked"]')).toHaveLength(1);
    });

    it('user opens a legacy value without rule metadata then the interface does not invent a rule from its category or mode', async () => {
        const details = snapshot();
        delete details.values[0]!.matches;
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, {
            props: { record: { ...record, mode: 'model' } },
        });
        await flushPromises();
        expect(wrapper.find('[data-testid="privacy-protection-value-rule"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('AstrLink');
    });

    it('user switches language then the inline columns and rule explanations are translated while the captured values stay exact', async () => {
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        setLocale('en-US');
        await flushPromises();
        expect(
            wrapper
                .findAll('[data-testid="privacy-protection-stage-label"]')
                .map((header) => header.text())
        ).toEqual(['Before masking', 'After masking']);
        expect(wrapper.get('[data-testid="privacy-protection-value-original"]').text()).toBe(
            'ada@example.test'
        );
    });

    it('user opens a restored reply then full model context precedes its restored text and only converted occurrences are marked', async () => {
        const details = snapshot();
        const value = details.values[0]!;
        details.texts = [`Direct ${value.original}; restored ${value.placeholder}.`];
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, {
            props: { record: { ...record, direction: 'restore' } },
        });
        await flushPromises();
        const panes = wrapper.findAll('[data-testid="privacy-protection-stage"]');
        expect(panes[0]!.attributes('aria-label')).toBe('还原前');
        expect(panes[0]!.text()).toBe(details.texts[0]);
        expect(panes[1]!.attributes('aria-label')).toBe('还原后');
        expect(panes[1]!.text()).toBe(`Direct ${value.original}; restored ${value.original}.`);
        expect(panes[1]!.findAll('[data-testid="privacy-protection-value-original"]')).toHaveLength(
            1
        );
    });
});
