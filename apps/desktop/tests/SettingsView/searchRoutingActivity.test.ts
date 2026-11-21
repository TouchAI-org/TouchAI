import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { DEFAULT_SEARCH_SETTINGS } from '@/app/api/settings/tools';
import { AppEvent, eventService } from '@/app/workflows/windows/events';
import SearchRoutingDiagram from '@/views/SettingsView/components/Search/components/SearchRoutingDiagram.vue';

describe('user watches live routing while the search settings are open', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('user opens a route menu from the keyboard and picks an engine with its logo', async () => {
        const wrapper = mount(SearchRoutingDiagram, {
            props: {
                settings: DEFAULT_SEARCH_SETTINGS,
                options: [
                    { value: 'auto', label: 'Auto' },
                    { value: 'openalex', label: 'OpenAlex', iconSrc: '/logos/openalex.png' },
                    { value: 'exa', label: 'Exa', iconSrc: '/logos/exa.svg' },
                ],
                disabled: false,
            },
            attachTo: document.body,
        });
        await wrapper
            .get('[data-testid="search-source-route-academic"]')
            .trigger('keydown', { key: 'Enter' });
        await flushPromises();
        const menu = document.querySelector('[data-testid="search-source-menu-academic"]')!;
        expect(menu.textContent).toContain('OpenAlex');
        expect(menu.querySelectorAll('[role="option"] img')).toHaveLength(3);
        menu.querySelectorAll('[role="option"]')[2]!.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true })
        );
        await flushPromises();
        expect(wrapper.emitted('select')).toEqual([['academic', 'exa']]);
        wrapper.unmount();
    });

    it('user enables reduced motion and gets no travelling search particles', async () => {
        vi.stubGlobal('matchMedia', () => ({
            matches: true,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }));
        const wrapper = mount(SearchRoutingDiagram, {
            props: { settings: DEFAULT_SEARCH_SETTINGS, options: [], disabled: false },
        });
        await flushPromises();
        await eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, {
            id: 'reduced',
            source: 'academic',
            provider: 'openalex',
            phase: 'searching',
            sites: [],
            timeoutMs: 15000,
        });
        await nextTick();
        expect(wrapper.find('[data-testid="search-route-activity"]').exists()).toBe(false);
        expect(wrapper.findAll('[role="combobox"]')).toHaveLength(7);
        wrapper.unmount();
    });

    it('user turns off search and existing activity disappears immediately', async () => {
        const wrapper = mount(SearchRoutingDiagram, {
            props: { settings: DEFAULT_SEARCH_SETTINGS, options: [], disabled: false },
        });
        await flushPromises();
        await eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, {
            id: 'disabled',
            source: 'academic',
            provider: 'openalex',
            phase: 'searching',
            sites: [],
            timeoutMs: 15000,
        });
        await nextTick();
        expect(wrapper.find('[data-testid="search-route-activity"]').exists()).toBe(true);
        await wrapper.setProps({ disabled: true });
        expect(wrapper.find('[data-testid="search-route-activity"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it('user waits for slow results and sees the gray dot reach the bottom of its route', async () => {
        const wrapper = mount(SearchRoutingDiagram, {
            props: { settings: DEFAULT_SEARCH_SETTINGS, options: [], disabled: false },
            attachTo: document.body,
        });
        try {
            await flushPromises();
            await eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, {
                id: 'slow-result',
                source: 'code',
                provider: 'github',
                phase: 'searching',
                sites: [],
                timeoutMs: 15000,
            });
            await vi.waitFor(
                () => {
                    const dot = wrapper.get<HTMLElement>('[data-testid="search-route-activity"]');
                    expect(dot.element.style.offsetDistance).toBe('100%');
                },
                { timeout: 2500 }
            );
            expect(wrapper.find('[data-testid="search-route-activity"] img').exists()).toBe(false);
        } finally {
            wrapper.unmount();
        }
    });

    it('user sees the requested branch and only real returned sites, then stops on failure', async () => {
        const wrapper = mount(SearchRoutingDiagram, {
            props: { settings: DEFAULT_SEARCH_SETTINGS, options: [], disabled: false },
        });
        await flushPromises();
        const activity = {
            id: 'search-1',
            source: 'academic' as const,
            provider: 'openalex' as const,
            phase: 'searching' as const,
            sites: [],
            timeoutMs: 15000,
        };
        await eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, activity);
        await nextTick();
        expect(wrapper.get('[data-testid="search-route-activity"]').attributes('data-source')).toBe(
            'academic'
        );
        await eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, {
            ...activity,
            phase: 'results',
            sites: [{ url: 'https://example.com', favicon: 'https://example.com/icon.png' }],
        });
        await nextTick();
        expect(wrapper.get('[data-testid="search-route-activity"]').attributes('data-phase')).toBe(
            'results'
        );
        await eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, { ...activity, phase: 'stopped' });
        await nextTick();
        expect(wrapper.find('[data-testid="search-route-activity"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it('user receives fast results and sees the site logos return after the outgoing request arrives', async () => {
        const wrapper = mount(SearchRoutingDiagram, {
            props: { settings: DEFAULT_SEARCH_SETTINGS, options: [], disabled: false },
            attachTo: document.body,
        });
        await flushPromises();
        const activity = {
            id: 'fast-result',
            source: 'code' as const,
            provider: 'github' as const,
            phase: 'searching' as const,
            sites: [],
            timeoutMs: 15000,
        };
        await eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, activity);
        await nextTick();
        await eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, {
            ...activity,
            phase: 'results',
            sites: [{ url: 'https://example.com', favicon: 'https://example.com/site.png' }],
        });
        await vi.waitFor(
            () =>
                expect(
                    wrapper.find('[data-testid="search-route-activity"] img').attributes('src')
                ).toBe('https://example.com/site.png'),
            { timeout: 2500 }
        );
        await vi.waitFor(
            () =>
                expect(wrapper.find('[data-testid="search-route-activity"]').exists()).toBe(false),
            { timeout: 2500 }
        );
        wrapper.unmount();
    });

    it('user leaves searches running and stale visual activity expires without retaining history', async () => {
        vi.useFakeTimers();
        const wrapper = mount(SearchRoutingDiagram, {
            props: { settings: DEFAULT_SEARCH_SETTINGS, options: [], disabled: false },
        });
        await nextTick();
        await Promise.resolve();
        for (let index = 0; index < 20; index++) {
            await eventService.emit(AppEvent.WEB_SEARCH_ACTIVITY, {
                id: `search-${index}`,
                source: 'general',
                provider: 'anysearch',
                phase: 'searching',
                sites: [],
                timeoutMs: 1000,
            });
        }
        await nextTick();
        expect(wrapper.findAll('[data-testid="search-route-activity"]').length).toBeGreaterThan(0);
        expect(wrapper.findAll('[data-testid="search-route-activity"]').length).toBeLessThanOrEqual(
            12
        );
        await vi.advanceTimersByTimeAsync(4000);
        expect(wrapper.find('[data-testid="search-route-activity"]').exists()).toBe(false);
        wrapper.unmount();
    });
});
