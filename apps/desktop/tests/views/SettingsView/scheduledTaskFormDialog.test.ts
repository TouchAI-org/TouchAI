import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import ScheduledTaskFormDialog from '@/views/SettingsView/components/ScheduledTasks/ScheduledTaskFormDialog.vue';

vi.mock('@components/DialogShell.vue', () => ({
    default: {
        props: ['open'],
        template: '<div><slot /></div>',
    },
}));

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options', 'disabled'],
        emits: ['update:modelValue'],
        template: `
            <select
                :value="modelValue"
                :disabled="disabled"
                @change="$emit('update:modelValue', $event.target.value)"
            >
                <option v-for="option in options" :key="option.value" :value="option.value">
                    {{ option.label }}
                </option>
            </select>
        `,
    },
}));

vi.mock('@components/ui/button', () => ({
    Button: {
        props: ['type', 'variant', 'disabled'],
        template: '<button :type="type || \'button\'" :disabled="disabled"><slot /></button>',
    },
}));

vi.mock('@components/ui/switch', () => ({
    Switch: {
        props: ['modelValue'],
        emits: ['update:modelValue'],
        template: '<button type="button" @click="$emit(\'update:modelValue\', !modelValue)" />',
    },
}));

function mountDialog() {
    return mount(ScheduledTaskFormDialog, {
        props: {
            open: true,
            models: [],
        },
    });
}

beforeEach(() => {
    setLocale('zh-CN');
});

describe('user creates a scheduled task', () => {
    it('user gets a recurring task from the name, prompt, and default daily preset', async () => {
        const wrapper = mountDialog();
        await wrapper.get('[data-testid="scheduled-task-name"]').setValue('  Daily digest  ');
        await wrapper.get('[data-testid="scheduled-task-prompt"]').setValue('  Summarize my day  ');

        await wrapper.get('form').trigger('submit');

        expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({
            name: 'Daily digest',
            prompt: 'Summarize my day',
            timezone: expect.any(String),
            trigger: {
                type: 'cron',
                expression: expect.stringMatching(/^\d{1,2} \d{1,2} \* \* \*$/),
            },
        });
    });

    it('user is blocked from saving a one-time task in the past', async () => {
        const wrapper = mountDialog();
        await wrapper.get('[data-testid="scheduled-task-name"]').setValue('Expired');
        await wrapper.get('[data-testid="scheduled-task-prompt"]').setValue('Run');

        const triggerSelect = wrapper
            .findAllComponents({ name: 'CustomSelect' })
            .find((select) =>
                select.props('options').some((option: { value: string }) => option.value === 'once')
            );
        await triggerSelect!.vm.$emit('update:modelValue', 'once');
        await wrapper.vm.$nextTick();
        const inputs = wrapper.findAll('input');
        const date = inputs.find((input) => input.attributes('type') === 'date');
        await date!.setValue('2020-01-01');

        await wrapper.get('form').trigger('submit');

        expect(wrapper.get('[data-testid="scheduled-task-validation"]').text()).toBe(
            '一次性任务的日期和时间必须晚于现在。'
        );
        expect(wrapper.emitted('save')).toBeUndefined();
    });
});
