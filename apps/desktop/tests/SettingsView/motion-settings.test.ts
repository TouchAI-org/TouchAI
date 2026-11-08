import { createSettingsBus } from '@tests/utils/settingsTransport';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { setActiveSettingsService } from '@/services/SettingsService';
import { SettingsService } from '@/services/SettingsService/service';
import { useSettingsStore } from '@/stores/settings';
import MotionSettingsSection from '@/views/SettingsView/components/General/MotionSettingsSection.vue';

const { getSettingValues, setSetting, error } = vi.hoisted(() => ({
    getSettingValues: vi.fn(async () => ({})),
    setSetting: vi.fn(async ({ key, value }: { key: string; value: string }) => ({
        id: 1,
        key,
        value,
        created_at: '',
        updated_at: '',
    })),
    error: vi.fn(),
}));
vi.mock('@database/queries', () => ({
    getSettingValues,
    setSetting,
}));
vi.mock('@services/NativeService', () => ({
    native: {
        autostart: {
            isAutostartEnabled: vi.fn(async () => false),
            enableAutostart: vi.fn(async () => undefined),
            disableAutostart: vi.fn(async () => undefined),
        },
        shortcut: {
            registerGlobalShortcut: vi.fn(async () => undefined),
        },
        window: {
            setSearchWindowDefaults: vi.fn(async () => undefined),
        },
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
    getSettingValues.mockResolvedValue({});
    setSetting.mockImplementation(async ({ key, value }: { key: string; value: string }) => ({
        id: 1,
        key,
        value,
        created_at: '',
        updated_at: '',
    }));
    setLocale('zh-CN');
});

describe('user changes motion in General settings', () => {
    let bus: ReturnType<typeof createSettingsBus>;
    let owner: SettingsService;

    beforeEach(() => {
        bus = createSettingsBus();
        owner = new SettingsService({ transport: bus.transport('main') });
        setActiveSettingsService(owner);
    });

    afterEach(() => {
        setActiveSettingsService(null);
    });

    it('user persists the selected speed and broadcasts it to other windows', async () => {
        const store = useSettingsStore();
        await store.initialize();
        const wrapper = mount(MotionSettingsSection);
        await wrapper.get('select').setValue('faster');
        await flushPromises();
        expect(store.animationSpeed).toBe('faster');
        expect(setSetting).toHaveBeenLastCalledWith({ key: 'animation_speed', value: 'faster' });
        expect(bus.sent).toContainEqual(
            expect.objectContaining({
                message: expect.objectContaining({
                    kind: 'notice',
                    type: 'change',
                    changedKeys: ['animation_speed'],
                }),
            })
        );
        await wrapper.get('[role="switch"]').trigger('click');
        await flushPromises();
        expect(store.automaticallyReduceMotion).toBe(false);
        expect(setSetting).toHaveBeenLastCalledWith({
            key: 'automatically_reduce_motion',
            value: 'false',
        });
        wrapper.unmount();
    });

    it('user retains the previous choice and receives an error when saving fails', async () => {
        const store = useSettingsStore();
        const wrapper = mount(MotionSettingsSection);
        setSetting.mockRejectedValueOnce(new Error('storage unavailable'));
        await wrapper.get('select').setValue('slower');
        await flushPromises();
        expect(store.animationSpeed).toBe('standard');
        expect(error).toHaveBeenCalled();
        expect(wrapper.get('select').attributes('disabled')).toBeUndefined();
        wrapper.unmount();
    });

    it('user sees saved choices from another window without writing them again', async () => {
        const store = useSettingsStore();
        await store.initialize();
        const wrapper = mount(MotionSettingsSection);
        const otherWindow = new SettingsService({ transport: bus.transport('win-settings') });
        await otherWindow.initialize();
        setSetting.mockClear();

        await otherWindow.mutate('animation_speed', 'slower');
        await otherWindow.mutate('automatically_reduce_motion', false);
        await flushPromises();
        expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('slower');
        expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false');
        expect(setSetting).toHaveBeenCalledTimes(2);
        wrapper.unmount();
    });
});
