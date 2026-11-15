import type { InvokeArgs } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type {
    PrivacyProtectionDetails,
    PrivacyProtectionRecord,
} from '@/services/NativeService/privacyFilter';
import PrivacyProtectionDetailsView from '@/views/SettingsView/components/PrivacyFilter/PrivacyProtectionDetails.vue';
import PrivacyProtectionRecords from '@/views/SettingsView/components/PrivacyFilter/PrivacyProtectionRecords.vue';

import { mockTauriCommand } from '../utils/tauri';

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
});

describe('given the user expands a memory-only replacement list', () => {
    it('user opens an inline list then sees original values, replacements and real rule descriptions without a modal or second reveal step', async () => {
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        expect(wrapper.findAll('th').map((header) => header.text())).toEqual([
            '原值',
            '替换后',
            '命中规则',
        ]);
        expect(wrapper.get('[data-testid="privacy-protection-value-original"]').text()).toBe(
            'ada@example.test'
        );
        expect(wrapper.get('[data-testid="privacy-protection-value-masked"]').text()).toBe(
            '{{EMAIL_0123456789abcdef}}'
        );
        expect(wrapper.get('[data-testid="privacy-protection-value-rule"]').text()).toContain(
            '邮箱地址格式'
        );
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

    it('user expands many replacements then paging limits initial rows without discarding the rest', async () => {
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
        expect(wrapper.findAll('[data-testid="privacy-protection-value"]')).toHaveLength(20);
        await wrapper.get('[data-testid="privacy-protection-values-more"]').trigger('click');
        expect(wrapper.findAll('[data-testid="privacy-protection-value"]')).toHaveLength(25);
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

    it('user reads captured custom and model matches then sees the actual configured prefix or word and model detector', async () => {
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
        const rules = wrapper.findAll('[data-testid="privacy-protection-value-rule"]');
        expect(rules[0]!.text()).toContain('自定义密钥前缀：company_token_');
        expect(rules[1]!.text()).toContain('自定义词语：Project Nightfall');
        expect(rules[2]!.text()).toContain('AstrLink Guard INT8');
        expect(rules[2]!.text()).toContain('识别为姓名');
    });

    it('user expands one value found by different sources then each actual matching rule remains visible with its count', async () => {
        const details = snapshot();
        details.values[0]!.count = 3;
        details.values[0]!.matches = [
            { id: 'email', count: 2 },
            { id: 'localModel', modelId: 'astrlink-guard-int8', count: 1 },
        ];
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        expect(wrapper.findAll('[data-testid="privacy-protection-value"]')).toHaveLength(1);
        const ruleCell = wrapper.get('[data-testid="privacy-protection-value-rule"]');
        expect(ruleCell.text()).toContain('邮箱地址格式');
        expect(ruleCell.text()).toContain('AstrLink Guard INT8');
        expect(ruleCell.text()).toContain('×2');
        expect(ruleCell.text()).toContain('×1');
    });

    it('user opens a legacy value without rule metadata then the interface does not invent a rule from its category or mode', async () => {
        const details = snapshot();
        delete details.values[0]!.matches;
        mockTauriCommand('privacy_filter_record_details', details);
        const wrapper = mount(PrivacyProtectionDetailsView, {
            props: { record: { ...record, mode: 'model' } },
        });
        await flushPromises();
        expect(wrapper.get('[data-testid="privacy-protection-value-rule"]').text()).toContain(
            '未保留命中规则'
        );
        expect(wrapper.text()).not.toContain('AstrLink');
    });

    it('user switches language then the inline columns and rule explanations are translated while the captured values stay exact', async () => {
        const wrapper = mount(PrivacyProtectionDetailsView, { props: { record } });
        await flushPromises();
        setLocale('en-US');
        await flushPromises();
        expect(wrapper.findAll('th').map((header) => header.text())).toEqual([
            'Original value',
            'Replacement',
            'Matched rule',
        ]);
        expect(wrapper.get('[data-testid="privacy-protection-value-rule"]').text()).toContain(
            'Email address format'
        );
        expect(wrapper.get('[data-testid="privacy-protection-value-original"]').text()).toBe(
            'ada@example.test'
        );
    });
});
