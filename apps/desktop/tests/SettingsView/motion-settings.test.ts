import { chooseSettingsOption, createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'vue-sonner';

import MotionSettingsSection from '@/views/SettingsView/components/General/MotionSettingsSection.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
let wrapper: VueWrapper | undefined;
let rejectSave = false;
let writes: string[];
beforeEach(async () => {
    vi.useFakeTimers();
    rejectSave = false;
    writes = [];
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
    fixture = await createSettingsPanelFixture({
        values: { language: 'en-US' },
        query: {
            beforeQuery({ sql, params }) {
                if (rejectSave && sql.startsWith('insert') && params[0] === 'animation_speed')
                    throw new Error('fixture storage unavailable');
            },
            afterQuery({ sql, params }) {
                if (
                    sql.startsWith('insert') &&
                    ['animation_speed', 'automatically_reduce_motion'].includes(String(params[0]))
                )
                    writes.push(String(params[0]));
            },
        },
    });
});
afterEach(async () => {
    toast.dismiss();
    wrapper?.unmount();
    wrapper = undefined;
    await fixture.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});
const openPanel = () => (wrapper = mount(MotionSettingsSection, fixture.viewOptions));

describe('given motion controls use the production preferences client and main writer', () => {
    it('user chooses a speed and automatic reduction and other windows see the committed values', async () => {
        const panel = openPanel();
        await chooseSettingsOption(panel.get('[role="combobox"]'), 'Faster');
        await flushPromises();
        expect(fixture.preferences.animationSpeed).toBe('faster');
        expect(fixture.saved('animation_speed')).toBe('faster');
        expect(fixture.window.settings.getSnapshot().animationSpeed).toBe('faster');
        await panel.get('[role="switch"]').trigger('click');
        await flushPromises();
        expect(fixture.preferences.automaticallyReduceMotion).toBe(false);
        expect(fixture.saved('automatically_reduce_motion')).toBe('false');
        expect(fixture.window.settings.getSnapshot().automaticallyReduceMotion).toBe(false);
    });

    it('user encounters a failed save and retains the previous choice with a visible error and a usable control', async () => {
        const panel = openPanel();
        rejectSave = true;
        await chooseSettingsOption(panel.get('[role="combobox"]'), 'Slower');
        await flushPromises();
        await vi.advanceTimersByTimeAsync(50);
        expect(fixture.preferences.animationSpeed).toBe('standard');
        expect(fixture.saved('animation_speed')).toBe('standard');
        expect(document.body.textContent).toContain('Failed to save settings');
        expect(panel.get('[role="combobox"]').attributes('disabled')).toBeUndefined();
        rejectSave = false;
        await chooseSettingsOption(panel.get('[role="combobox"]'), 'Faster');
        await flushPromises();
        expect(fixture.saved('animation_speed')).toBe('faster');
    });

    it('user sees another window choices without the panel writing a second copy', async () => {
        const panel = openPanel();
        writes.length = 0;
        const original = fixture.saved('animation_speed');
        await fixture.window.settings.mutate('animation_speed', 'slower');
        await fixture.window.settings.mutate('automatically_reduce_motion', false);
        await flushPromises();
        expect(panel.get('[role="combobox"]').text()).toContain('Slower');
        expect(panel.get('[role="switch"]').attributes('aria-checked')).toBe('false');
        expect(fixture.saved('animation_speed')).not.toBe(original);
        expect(fixture.saved('automatically_reduce_motion')).toBe('false');
        expect(writes).toEqual(['animation_speed', 'automatically_reduce_motion']);
    });
});
