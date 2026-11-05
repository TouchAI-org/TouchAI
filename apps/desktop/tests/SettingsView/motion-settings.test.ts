import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import MotionSettingsSection from '@/views/SettingsView/components/General/MotionSettingsSection.vue';

const { save, emit, handlers, error } = vi.hoisted(() => ({
    save: vi.fn(),
    emit: vi.fn(),
    handlers: new Map<string, (payload: unknown) => void>(),
    error: vi.fn(),
}));
vi.mock('@database/queries', () => ({
    getSettingValue: vi.fn(async () => null),
    setSetting: save,
}));
vi.mock('@services/EventService', () => ({
    AppEvent: { SETTINGS_GENERAL_UPDATED: 'settings-general-updated' },
    eventService: {
        emit,
        on: vi.fn(async (event, handler) => {
            handlers.set(event, handler);
            return () => handlers.delete(event);
        }),
    },
}));
vi.mock('@components/AlertMessage.vue', () => ({
    default: { template: '<div />', methods: { error } },
}));
vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        props: ['modelValue', 'options', 'disabled'],
        emits: ['update:modelValue'],
        template:
            '<select :value="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :value="option.value">{{ option.label }}</option></select>',
    },
}));

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    handlers.clear();
    save.mockResolvedValue(undefined);
    setLocale('zh-CN');
});

describe('user changes motion in General settings', () => {
    it('user persists the selected speed and broadcasts it to other windows', async () => {
        const store = useSettingsStore();
        await store.initialize();
        const wrapper = mount(MotionSettingsSection);
        await wrapper.get('select').setValue('faster');
        await flushPromises();
        expect(store.animationSpeed).toBe('faster');
        expect(save).toHaveBeenLastCalledWith({ key: 'animation_speed', value: 'faster' });
        expect(emit).toHaveBeenLastCalledWith(
            'settings-general-updated',
            expect.objectContaining({ key: 'animation_speed', value: 'faster' })
        );
        await wrapper.get('[role="switch"]').trigger('click');
        await flushPromises();
        expect(store.automaticallyReduceMotion).toBe(false);
        expect(save).toHaveBeenLastCalledWith({
            key: 'automatically_reduce_motion',
            value: 'false',
        });
        wrapper.unmount();
    });

    it('user retains the previous choice and receives an error when saving fails', async () => {
        const store = useSettingsStore();
        const wrapper = mount(MotionSettingsSection);
        save.mockRejectedValueOnce(new Error('storage unavailable'));
        await wrapper.get('select').setValue('slower');
        await flushPromises();
        expect(store.animationSpeed).toBe('standard');
        expect(error).toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(wrapper.get('select').attributes('disabled')).toBeUndefined();
        wrapper.unmount();
    });

    it('user sees saved choices from another window without writing them again', async () => {
        const store = useSettingsStore();
        await store.initialize();
        const wrapper = mount(MotionSettingsSection);
        save.mockClear();
        const update = handlers.get('settings-general-updated')!;
        update({ sourceId: 'other', key: 'animation_speed', value: 'slower' });
        update({ sourceId: 'other', key: 'automatically_reduce_motion', value: false });
        await flushPromises();
        expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('slower');
        expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false');
        expect(save).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});
