import { log } from '@services/ObservabilityService';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import AppIcon from '@/components/AppIcon.vue';
import { appIconFallback, appIconMap } from '@/components/appIconMap';

/**
 * An icon name is looked up in a map built from the icon set. A name that is not in the map has
 * to fall back to a placeholder rather than render nothing, or the layout collapses and the
 * missing icon only shows up when someone looks at the screen.
 */
function renderedIcon(name: string) {
    return mount(AppIcon, { props: { name: name as never } }).html();
}

describe('user sees an icon they asked for', () => {
    it('user gets the icon registered under that name', () => {
        const known = Object.keys(appIconMap)[0]!;

        // The mapped icon and the fallback are different components, so their markup differs.
        expect(renderedIcon(known)).not.toBe(renderedIcon('definitely-not-an-icon'));
    });

    it('user gets a placeholder when the name is not in the icon set', () => {
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

        const unknown = renderedIcon('no-such-icon');
        const fallback = mount(appIconFallback).html();

        // Rendering nothing would collapse the surrounding row; the placeholder keeps the box.
        expect(unknown).toContain(fallback.replace(/^<[^>]+>|<\/[^>]+>$/g, '').slice(0, 40));

        warn.mockRestore();
    });

    it('user gets one warning for a missing icon however many times it renders', async () => {
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

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
