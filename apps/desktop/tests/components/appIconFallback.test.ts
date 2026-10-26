import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import AppIcon from '@/components/AppIcon.vue';
import { appIconMap } from '@/components/appIconMap';

/**
 * An icon name is looked up in a map built from the icon set. A name that is not in the map has
 * to fall back to a placeholder rather than render nothing, or the layout collapses and the
 * missing icon only shows up when someone looks at the screen.
 */
describe('user sees an icon they asked for', () => {
    it('user gets the icon that matches the name', () => {
        const known = Object.keys(appIconMap)[0]!;

        const wrapper = mount(AppIcon, { props: { name: known as never } });

        // The resolved component is mounted in place of the icon name.
        expect(wrapper.find('.app-icon').exists()).toBe(true);
    });

    it('user gets a placeholder when the name is not in the icon set', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const wrapper = mount(AppIcon, { props: { name: 'no-such-icon' as never } });

        // Rendering nothing would collapse the surrounding row.
        expect(wrapper.find('.app-icon').exists()).toBe(true);

        warn.mockRestore();
    });

    it('user gets one warning for a missing icon however many times it renders', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const wrapper = mount(AppIcon, { props: { name: 'no-such-icon-either' as never } });
        await wrapper.setProps({ name: 'no-such-icon-either' as never });
        await wrapper.vm.$nextTick();

        // One warning per unknown name keeps a list of them readable in the console.
        expect(warn).toHaveBeenCalledTimes(1);

        warn.mockRestore();
    });

    it('user gets the extra attributes passed through to the icon', () => {
        const known = Object.keys(appIconMap)[0]!;

        const wrapper = mount(AppIcon, {
            props: { name: known as never },
            attrs: { 'data-testid': 'toolbar-icon' },
        });

        // inheritAttrs is off, so the component has to forward them itself.
        expect(wrapper.find('[data-testid="toolbar-icon"]').exists()).toBe(true);
    });
});
