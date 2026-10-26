import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import NavigationSidebar from '@/views/SettingsView/components/NavigationSidebar.vue';
import { SETTINGS_SIDEBAR_COLLAPSED_WIDTH } from '@/views/SettingsView/settingsSidebarLayout';

import desktopPackageJson from '../../../package.json';

/*
 * The existing navigationSidebar test covers the destination list, the version
 * badge, external links and resizing. This file covers what the same sidebar does
 * once it is collapsed or once the user starts searching: the labels go away, the
 * rail narrows, and the search panel takes over from the destination list.
 */

const openUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }));

// The search panel has its own matching logic; here only its contract with the
// sidebar matters, so it exposes one result and one expand request.
vi.mock('@/views/SettingsView/components/SettingsSearch.vue', () => ({
    default: {
        name: 'SettingsSearchStub',
        props: ['modelValue', 'collapsed'],
        emits: ['update:modelValue', 'expand', 'select'],
        template: `
            <div data-testid="settings-search">
                <input
                    data-testid="settings-search-input"
                    :value="modelValue"
                    @input="$emit('update:modelValue', $event.target.value)"
                />
                <button
                    type="button"
                    data-testid="settings-search-expand"
                    @click="$emit('expand')"
                >
                    expand
                </button>
                <button
                    type="button"
                    data-testid="settings-search-pick"
                    @click="$emit('select', { section: 'general', targetId: 'start-on-boot' })"
                >
                    pick
                </button>
            </div>
        `,
    },
}));

enableAutoUnmount(afterEach);

function mountSidebar(activeSection: string = 'general') {
    return mount(NavigationSidebar, {
        props: { activeSection: activeSection as never },
        attachTo: document.body,
    });
}

function sidebar(wrapper: ReturnType<typeof mountSidebar>) {
    return wrapper.get('[data-testid="settings-sidebar"]');
}

function resizer(wrapper: ReturnType<typeof mountSidebar>) {
    return wrapper.get('[data-testid="settings-sidebar-resizer"]');
}

async function collapseWithKeyboard(wrapper: ReturnType<typeof mountSidebar>) {
    await resizer(wrapper).trigger('keydown', { key: 'Enter' });
    // The label fades first and the rail narrows after the fade.
    await vi.advanceTimersByTimeAsync(200);
}

beforeEach(() => {
    vi.useFakeTimers();
    setLocale('zh-CN');
    openUrlMock.mockReset();
    openUrlMock.mockResolvedValue(undefined);
});

describe('user collapses the settings sidebar', () => {
    it('user gets a narrow rail after pressing Enter on the divider', async () => {
        const wrapper = mountSidebar();

        await collapseWithKeyboard(wrapper);

        expect(sidebar(wrapper).attributes('data-collapsed')).toBe('true');
        expect(resizer(wrapper).attributes('aria-expanded')).toBe('false');
        expect(sidebar(wrapper).attributes('style')).toContain(
            `width: ${SETTINGS_SIDEBAR_COLLAPSED_WIDTH}px`
        );
    });

    it('user sees the labels fade out before the rail narrows', async () => {
        const wrapper = mountSidebar();

        await resizer(wrapper).trigger('keydown', { key: 'Enter' });

        // Labels hide immediately; the rail is still wide until the fade ends.
        expect(sidebar(wrapper).attributes('data-labels-visible')).toBe('false');
        expect(sidebar(wrapper).attributes('data-collapsed')).toBe('false');

        await vi.advanceTimersByTimeAsync(200);
        expect(sidebar(wrapper).attributes('data-collapsed')).toBe('true');
    });

    it('user gets the rail back at its previous width after pressing Enter again', async () => {
        const wrapper = mountSidebar();
        await collapseWithKeyboard(wrapper);

        await resizer(wrapper).trigger('keydown', { key: 'Enter' });
        await vi.advanceTimersByTimeAsync(300);

        expect(sidebar(wrapper).attributes('data-collapsed')).toBe('false');
        expect(resizer(wrapper).attributes('aria-expanded')).toBe('true');
        expect(sidebar(wrapper).attributes('data-labels-visible')).toBe('true');
    });

    it('user gets the same toggle from the space key', async () => {
        const wrapper = mountSidebar();

        await resizer(wrapper).trigger('keydown', { key: ' ' });

        expect(sidebar(wrapper).attributes('data-labels-visible')).toBe('false');
    });

    it('user gets the whole rail expanded again by searching while collapsed', async () => {
        const wrapper = mountSidebar();
        await collapseWithKeyboard(wrapper);

        wrapper.findComponent({ name: 'SettingsSearchStub' }).vm.$emit('update:modelValue', 'boot');
        await wrapper.vm.$nextTick();

        await wrapper.get('[data-testid="settings-search-expand"]').trigger('click');
        await vi.advanceTimersByTimeAsync(300);

        expect(sidebar(wrapper).attributes('data-collapsed')).toBe('false');
    });

    it('user gets a destination icon still reachable while the rail is collapsed', async () => {
        const wrapper = mountSidebar();
        await collapseWithKeyboard(wrapper);

        await wrapper.get('[data-testid="settings-nav-shortcuts"]').trigger('click');

        expect(wrapper.emitted('navigate')?.[0]).toEqual(['shortcuts']);
    });

    it('user sees the version badge put away while the rail is collapsed', async () => {
        const wrapper = mountSidebar();
        expect(wrapper.get('[data-testid="settings-sidebar-version"]').isVisible()).toBe(true);

        await collapseWithKeyboard(wrapper);

        expect(wrapper.get('[data-testid="settings-sidebar-version"]').isVisible()).toBe(false);
    });

    it('user gets the version action taken away from the keyboard focus order too', async () => {
        const wrapper = mountSidebar();
        await collapseWithKeyboard(wrapper);

        const badge = wrapper.get('[data-testid="settings-sidebar-version"]');
        expect(badge.attributes('aria-hidden')).toBe('true');
        expect(badge.attributes('tabindex')).toBe('-1');
    });

    it('user sees the feedback link put away while the rail is collapsed', async () => {
        const wrapper = mountSidebar();
        await collapseWithKeyboard(wrapper);

        expect(wrapper.get('[data-testid="settings-sidebar-issues"]').classes()).toEqual(
            expect.arrayContaining(['w-0', 'opacity-0'])
        );
    });

    it('user still reaches the repository link from the collapsed rail', async () => {
        const wrapper = mountSidebar();
        await collapseWithKeyboard(wrapper);

        await wrapper.get('[data-testid="settings-sidebar-github"]').trigger('click');

        expect(openUrlMock).toHaveBeenCalledWith('https://github.com/TouchAI-org/TouchAI');
        expect(wrapper.get('[data-testid="settings-sidebar-github"]').classes()).toContain('h-10');
    });
});

describe('user searches for a setting from the sidebar', () => {
    it('user sees the destination list step aside while a query is typed', async () => {
        const wrapper = mountSidebar();
        expect(wrapper.find('nav').isVisible()).toBe(true);

        await wrapper.get('[data-testid="settings-search-input"]').setValue('boot');

        expect(wrapper.find('nav').isVisible()).toBe(false);
    });

    it('user gets the destination list back once the query is cleared', async () => {
        const wrapper = mountSidebar();
        await wrapper.get('[data-testid="settings-search-input"]').setValue('boot');

        await wrapper.get('[data-testid="settings-search-input"]').setValue('');

        expect(wrapper.find('nav').isVisible()).toBe(true);
    });

    it('user gets the picked search result forwarded to the window', async () => {
        const wrapper = mountSidebar();

        await wrapper.get('[data-testid="settings-search-pick"]').trigger('click');

        expect(wrapper.emitted('search-select')?.[0]).toEqual([
            { section: 'general', targetId: 'start-on-boot' },
        ]);
    });

    it('user sees the brand label translated alongside the destinations', () => {
        setLocale('en-US');
        const wrapper = mountSidebar();

        expect(wrapper.get('[data-testid="settings-sidebar-brand"]').text()).toContain('Settings');
        expect(wrapper.get('[data-testid="settings-sidebar-version"]').text()).toBe(
            `V${desktopPackageJson.version}`
        );
    });
});
