import { emit } from '@tauri-apps/api/event';
import { useTestPrivacyWindow } from '@tests/utils/privacyWindow';
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import PrivacyProtectionRecords from '@/views/SettingsView/components/PrivacyFilter/PrivacyProtectionRecords.vue';

import { getLastTauriInvokeCall, mockTauriCommand } from '../utils/tauri';

useTestPrivacyWindow();
enableAutoUnmount(afterEach);

const record = {
    id: 'request-1',
    createdAt: Date.now() - 60_000,
    mode: 'rules',
    outcome: 'protected',
    maskedCount: 3,
    categories: [
        { kind: 'email', count: 2 },
        { kind: 'secret', count: 1 },
    ],
};

beforeEach(() => {
    setLocale('zh-CN');
    mockTauriCommand('privacy_filter_records', []);
});

describe('given privacy protection records stored on this device', () => {
    it('user opens a slow record then sees a busy disclosure until its context is ready and can close it without retained text', async () => {
        let finish!: (details: unknown) => void;
        mockTauriCommand('privacy_filter_records', [record]);
        mockTauriCommand('privacy_filter_record_detail_ids', [record.id]);
        mockTauriCommand(
            'privacy_filter_record_details',
            new Promise((resolve) => {
                finish = resolve;
            })
        );
        const wrapper = mount(PrivacyProtectionRecords, { props: { disabled: false } });
        await flushPromises();
        const open = wrapper.get('[data-testid="privacy-protection-record-open"]');
        await open.trigger('click');
        await flushPromises();
        expect(open.attributes('aria-busy')).toBe('true');
        expect(wrapper.find('[data-testid="privacy-protection-record-loading"]').exists()).toBe(
            true
        );
        finish({
            values: [
                {
                    kind: 'email',
                    original: 'ready@example.test',
                    placeholder: '{{EMAIL_0123456789abcdef}}',
                    count: 1,
                },
            ],
            texts: [],
            truncated: false,
        });
        await flushPromises();
        expect(open.attributes('aria-busy')).toBe('false');
        expect(wrapper.find('[data-testid="privacy-protection-record-loading"]').exists()).toBe(
            false
        );
        expect(wrapper.text()).toContain('ready@example.test');
        await open.trigger('click');
        expect(wrapper.text()).not.toContain('ready@example.test');
    });

    it('user expands a record among many requests when showing more then twenty more cards append while the same record remains open', async () => {
        const records = Array.from({ length: 41 }, (_, index) => ({
            ...record,
            id: `request-${index + 1}`,
        }));
        mockTauriCommand('privacy_filter_records', records);
        mockTauriCommand('privacy_filter_record_detail_ids', [record.id]);
        mockTauriCommand('privacy_filter_record_details', {
            values: [
                {
                    kind: 'email',
                    original: 'ada@example.test',
                    placeholder: '{{EMAIL_0123456789abcdef}}',
                    count: 1,
                },
            ],
            texts: [],
            truncated: false,
        });
        const wrapper = mount(PrivacyProtectionRecords, { props: { disabled: false } });
        await flushPromises();
        expect(wrapper.findAll('[data-testid="privacy-protection-record"]')).toHaveLength(20);
        await wrapper.get('[data-testid="privacy-protection-record-open"]').trigger('click');
        await flushPromises();
        await wrapper.get('[data-testid="privacy-protection-records-more"]').trigger('click');
        await flushPromises();
        expect(wrapper.findAll('[data-testid="privacy-protection-record"]')).toHaveLength(40);
        expect(wrapper.findAll('[data-testid="privacy-protection-details"]')).toHaveLength(1);
        expect(
            wrapper
                .get('[data-testid="privacy-protection-record-open"]')
                .attributes('aria-expanded')
        ).toBe('true');
        await wrapper.get('[data-testid="privacy-protection-records-more"]').trigger('click');
        await flushPromises();
        expect(wrapper.findAll('[data-testid="privacy-protection-record"]')).toHaveLength(41);
        expect(wrapper.find('[data-testid="privacy-protection-records-more"]').exists()).toBe(
            false
        );
        expect(wrapper.text()).toContain('ada@example.test');
    });

    it('user expands a recent record then sees its original, replacement and matched rule inline without a dialog', async () => {
        const original = 'ada@example.test';
        const placeholder = '{{EMAIL_0123456789abcdef}}';
        mockTauriCommand('privacy_filter_records', [record]);
        mockTauriCommand('privacy_filter_record_detail_ids', [record.id]);
        mockTauriCommand('privacy_filter_record_details', {
            values: [
                {
                    kind: 'email',
                    original,
                    placeholder,
                    count: 2,
                    matches: [{ id: 'email', count: 2 }],
                },
            ],
            texts: [`Email ${placeholder} and ${placeholder}`],
            truncated: false,
        });
        const wrapper = mount(PrivacyProtectionRecords, {
            props: { disabled: false },
            attachTo: document.body,
        });
        await flushPromises();
        expect(wrapper.text()).not.toContain(original);
        await wrapper.get('[data-testid="privacy-protection-record-open"]').trigger('click');
        await flushPromises();
        const row = wrapper.get('[data-testid="privacy-protection-record"]');
        const details = row.get('[data-testid="privacy-protection-details"]');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(details.get('[data-testid="privacy-protection-value-original"]').text()).toBe(
            original
        );
        expect(details.get('[data-testid="privacy-protection-value-masked"]').text()).toBe(
            placeholder
        );
        expect(details.findAll('[data-testid="privacy-protection-stage"]')).toHaveLength(2);
        expect(details.find('[data-testid="privacy-protection-details-view"]').exists()).toBe(
            false
        );
        expect(
            row.get('[data-testid="privacy-protection-record-open"]').attributes('aria-expanded')
        ).toBe('true');
        expect(row.get('[data-testid="privacy-protection-record-count"]').text()).toBe('保护3条');
        expect(getLastTauriInvokeCall('privacy_filter_record_details')?.payload).toEqual({
            recordId: record.id,
        });
        await row.get('[data-testid="privacy-protection-record-open"]').trigger('click');
        await flushPromises();
        expect(row.find('[data-testid="privacy-protection-details"]').exists()).toBe(false);
        expect(document.body.textContent).not.toContain(original);
    });

    it('user revisits a summary after restart then it cannot be expanded and no disclosure control remains', async () => {
        mockTauriCommand('privacy_filter_records', [record]);
        mockTauriCommand('privacy_filter_record_detail_ids', []);
        const wrapper = mount(PrivacyProtectionRecords, {
            props: { disabled: false },
            attachTo: document.body,
        });
        await flushPromises();
        const open = wrapper.get('[data-testid="privacy-protection-record-open"]');
        expect(open.attributes('aria-disabled')).toBe('true');
        expect(open.attributes('tabindex')).toBe('-1');
        expect(wrapper.find('[data-testid="privacy-protection-record-chevron"]').exists()).toBe(
            false
        );
        await open.trigger('click');
        await flushPromises();
        expect(wrapper.find('[data-testid="privacy-protection-details"]').exists()).toBe(false);
        expect(wrapper.text()).toContain('规则 / 邮箱、密钥与凭据');
    });

    it('user cannot load a row then retries and sees its retained replacement list inline', async () => {
        mockTauriCommand('privacy_filter_records', [record]);
        mockTauriCommand('privacy_filter_record_detail_ids', [record.id]);
        mockTauriCommand('privacy_filter_record_details', () => {
            throw new Error('Unavailable');
        });
        const wrapper = mount(PrivacyProtectionRecords, {
            props: { disabled: false },
            attachTo: document.body,
        });
        await flushPromises();
        await wrapper.get('[data-testid="privacy-protection-record-open"]').trigger('click');
        await flushPromises();
        const details = wrapper.get('[data-testid="privacy-protection-details"]');
        expect(details.text()).toContain('无法读取脱敏详情');
        mockTauriCommand('privacy_filter_record_details', {
            values: [
                {
                    kind: 'email',
                    original: 'ada@example.test',
                    placeholder: '{{EMAIL_0123456789abcdef}}',
                    count: 2,
                },
            ],
            texts: [],
            truncated: true,
        });
        await details.get('[data-testid="privacy-protection-details-retry"]').trigger('click');
        await flushPromises();
        expect(details.text()).toContain('ada@example.test');
        expect(details.text()).toContain('脱敏前');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('user opens records without protected requests, then sees an empty state and retention information', async () => {
        const wrapper = mount(PrivacyProtectionRecords, { props: { disabled: false } });
        await flushPromises();
        expect(wrapper.text()).toContain('暂无保护记录');
        expect(wrapper.text()).toContain('保护内容仅在运行期间保留，最多保留30天或200条');
        expect(
            wrapper.get('[data-testid="privacy-protection-records-clear"]').attributes('disabled')
        ).toBeDefined();
    });

    it('user protects a request in another window, then sees its categories and can clear the records after confirmation', async () => {
        let records: unknown[] = [];
        mockTauriCommand('privacy_filter_records', () => records);
        mockTauriCommand('privacy_filter_clear_records', () => {
            records = [];
        });
        const wrapper = mount(PrivacyProtectionRecords, {
            props: { disabled: false },
            attachTo: document.body,
        });
        await flushPromises();
        records = [record];
        await emit('privacy-filter-records-changed', null);
        await flushPromises();
        expect(wrapper.text()).toContain('规则 / 邮箱、密钥与凭据');
        expect(wrapper.text()).toContain('邮箱');
        expect(wrapper.text()).toContain('规则');
        expect(
            wrapper
                .get('[data-testid="privacy-protection-summary-requests"]')
                .attributes('data-value')
        ).toBe('1');
        expect(
            wrapper
                .get('[data-testid="privacy-protection-summary-masked"]')
                .attributes('data-value')
        ).toBe('3');
        await wrapper.get('[data-testid="privacy-protection-records-clear"]').trigger('click');
        await flushPromises();
        expect(records).toHaveLength(1);
        const dialog = new DOMWrapper(document.querySelector<HTMLElement>('[role="alertdialog"]')!);
        await dialog
            .findAll('button')
            .find((button) => button.text() === '清空记录')!
            .trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('暂无保护记录');
    });

    it('user sees a record load failure, retries, and keeps records readable while protection is disabled', async () => {
        mockTauriCommand('privacy_filter_records', () => {
            throw new Error('Unavailable');
        });
        const wrapper = mount(PrivacyProtectionRecords, { props: { disabled: false } });
        await flushPromises();
        expect(wrapper.text()).toContain('无法读取保护记录');
        mockTauriCommand('privacy_filter_records', [record]);
        await wrapper.get('[data-testid="privacy-protection-records-retry"]').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('规则 / 邮箱、密钥与凭据');
        await wrapper.setProps({ disabled: true });
        for (const button of wrapper.findAll('button')) expect(button.element.disabled).toBe(true);
        expect(wrapper.text()).toContain('规则 / 邮箱、密钥与凭据');
    });

    it('user filters records by category, mode and outcome then sees matching summaries and date groups', async () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(12, 0, 0, 0);
        const records = [
            record,
            {
                id: 'request-2',
                createdAt: Date.now() - 120_000,
                mode: 'model',
                outcome: 'protected',
                maskedCount: 1,
                categories: [{ kind: 'secret', count: 1 }],
            },
            {
                id: 'request-3',
                createdAt: yesterday.getTime(),
                mode: 'model',
                outcome: 'blocked',
                maskedCount: 0,
                categories: [],
            },
        ];
        mockTauriCommand('privacy_filter_records', records);
        const wrapper = mount(PrivacyProtectionRecords, { props: { disabled: false } });
        await flushPromises();

        expect(wrapper.text()).toContain('今天');
        expect(wrapper.text()).toContain('昨天');
        expect(
            wrapper
                .get('[data-testid="privacy-protection-summary-requests"]')
                .attributes('data-value')
        ).toBe('3');
        expect(
            wrapper
                .get('[data-testid="privacy-protection-summary-masked"]')
                .attributes('data-value')
        ).toBe('4');
        expect(
            wrapper
                .get('[data-testid="privacy-protection-summary-blocked"]')
                .attributes('data-value')
        ).toBe('1');

        const category = wrapper.get('[data-testid="privacy-protection-records-category-filter"]');
        await category.trigger('keydown', { key: 'Enter' });
        await flushPromises();
        const email = document.querySelector<HTMLElement>(
            '[data-testid="privacy-protection-records-category-email"]'
        );
        expect(email).not.toBeNull();
        email!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await flushPromises();
        expect(wrapper.findAll('[data-testid="privacy-protection-record"]')).toHaveLength(1);
        const visibleRows = wrapper.findAll('[data-testid="privacy-protection-record"]');
        expect(visibleRows[0]!.text()).toContain('邮箱');
        expect(visibleRows[0]!.text()).not.toContain('电话号码');

        await category.trigger('keydown', { key: 'Enter' });
        await flushPromises();
        const allCategories = document.querySelector<HTMLElement>(
            '[data-testid="privacy-protection-records-category-all"]'
        );
        allCategories!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await flushPromises();
        const outcome = wrapper.get('[data-testid="privacy-protection-records-outcome-filter"]');
        await outcome.trigger('keydown', { key: 'Enter' });
        await flushPromises();
        const blocked = document.querySelector<HTMLElement>(
            '[data-testid="privacy-protection-records-outcome-blocked"]'
        );
        blocked!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await flushPromises();
        expect(wrapper.findAll('[data-testid="privacy-protection-record"]')).toHaveLength(1);
        expect(wrapper.text()).toContain('已阻止');
    });

    it('user switches from thirty days to seven days, then sees only recent summaries and totals', async () => {
        const old = new Date();
        old.setDate(old.getDate() - 10);
        mockTauriCommand('privacy_filter_records', [
            record,
            {
                id: 'request-old',
                createdAt: old.getTime(),
                mode: 'model',
                outcome: 'protected',
                maskedCount: 5,
                categories: [{ kind: 'phone', count: 5 }],
            },
        ]);
        const wrapper = mount(PrivacyProtectionRecords, {
            props: { disabled: false },
            attachTo: document.body,
        });
        await flushPromises();
        expect(
            wrapper
                .get('[data-testid="privacy-protection-summary-requests"]')
                .attributes('data-value')
        ).toBe('2');

        await wrapper
            .get('[data-testid="privacy-protection-records-range"]')
            .trigger('keydown', { key: 'Enter' });
        await flushPromises();
        const sevenDays = document.querySelector<HTMLElement>(
            '[data-testid="privacy-protection-records-range-7"]'
        );
        expect(sevenDays).not.toBeNull();
        sevenDays!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await flushPromises();

        expect(wrapper.findAll('[data-testid="privacy-protection-record"]')).toHaveLength(1);
        expect(
            wrapper
                .get('[data-testid="privacy-protection-summary-requests"]')
                .attributes('data-value')
        ).toBe('1');
        expect(wrapper.get('[data-testid="privacy-protection-records-range"]').text()).toContain(
            '近 7 天'
        );
    });

    it('user receives a restored reply when opening settings then its reverse record is counted separately from protected requests', async () => {
        mockTauriCommand('privacy_filter_records', [
            { ...record, id: 'reply-1', direction: 'restore', modelName: 'Kimi K2' },
            record,
        ]);
        const wrapper = mount(PrivacyProtectionRecords, { props: { disabled: false } });
        await flushPromises();
        const rows = wrapper.findAll('[data-testid="privacy-protection-record"]');
        expect(rows[0]!.text()).toContain('还原3条');
        expect(rows[1]!.text()).toContain('保护3条');
        expect(rows[0]!.get('[data-testid="privacy-protection-record-meta"]').text()).toMatch(
            /^Kimi K2/
        );
        expect(
            wrapper
                .get('[data-testid="privacy-protection-summary-requests"]')
                .attributes('data-value')
        ).toBe('1');
        expect(
            wrapper
                .get('[data-testid="privacy-protection-summary-masked"]')
                .attributes('data-value')
        ).toBe('3');
    });
});
