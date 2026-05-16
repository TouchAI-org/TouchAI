import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WindowInfo } from './types';

vi.mock('@/views/PopupView/components/ModelDropdownPopup/index.vue', () => ({
    default: { name: 'ModelDropdownPopupStub' },
}));

vi.mock('@/views/PopupView/components/SessionHistoryPopover/index.vue', () => ({
    default: { name: 'SessionHistoryPopoverStub' },
}));

function defineRect(
    element: HTMLElement,
    rect: Partial<DOMRect> & Pick<DOMRect, 'top' | 'right' | 'bottom'>
) {
    const left = rect.left ?? 0;
    const width = rect.width ?? Math.max(0, rect.right - left);
    const height = rect.height ?? Math.max(0, rect.bottom - rect.top);

    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () =>
            ({
                x: rect.x ?? left,
                y: rect.y ?? rect.top,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                left,
                width,
                height,
                toJSON: () => ({}),
            }) as DOMRect,
    });
}

function createWindowInfo(overrides: Partial<WindowInfo> = {}): WindowInfo {
    return {
        position: { x: 500, y: 300 },
        size: { width: 960, height: 200 },
        innerSize: { width: 920, height: 160 },
        scaleFactor: 1,
        screenSize: { width: 1800, height: 650 },
        screenPosition: { x: 0, y: 0 },
        ...overrides,
    };
}

async function loadRegistryModule() {
    vi.resetModules();
    return import('./registry');
}

describe('popupRegistry built-in contracts', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('registers the Rust-facing popup config contract for the built-in popups', async () => {
        const { initializeBuiltInPopups, popupRegistry } = await loadRegistryModule();

        initializeBuiltInPopups();

        expect(popupRegistry.has('model-dropdown-popup')).toBe(true);
        expect(popupRegistry.has('session-history-popup')).toBe(true);
        expect(popupRegistry.getSerializableConfig()).toEqual([
            { id: 'model-dropdown-popup', width: 320, height: 384 },
            { id: 'session-history-popup', width: 320, height: 384 },
        ]);
    });

    it('positions the model dropdown against the search bar container when the below-window placement overflows', async () => {
        const { initializeBuiltInPopups, popupRegistry } = await loadRegistryModule();
        initializeBuiltInPopups();

        const searchBarContainer = document.createElement('div');
        searchBarContainer.className = 'search-bar-container';
        defineRect(searchBarContainer, { top: 120, right: 420, bottom: 180, left: 40 });

        const trigger = document.createElement('button');
        defineRect(trigger, { top: 180, right: 410, bottom: 210, left: 260 });
        searchBarContainer.appendChild(trigger);
        document.body.appendChild(searchBarContainer);

        const config = popupRegistry.get('model-dropdown-popup');
        expect(config).toBeDefined();
        if (!config) {
            throw new Error('Expected model dropdown popup config');
        }
        const position = config.calculatePosition(trigger, createWindowInfo(), {
            width: config.width,
            height: 180,
        });

        expect(position).toEqual({
            x: 493,
            y: 235,
        });
    });

    it('uses the search-view container placement branch for session history popups', async () => {
        const { initializeBuiltInPopups, popupRegistry } = await loadRegistryModule();
        initializeBuiltInPopups();

        const trigger = document.createElement('button');
        trigger.className = 'search-view-container';
        defineRect(trigger, { top: 110, right: 360, bottom: 150, left: 40 });
        document.body.appendChild(trigger);

        const config = popupRegistry.get('session-history-popup');
        expect(config).toBeDefined();
        if (!config) {
            throw new Error('Expected session history popup config');
        }
        const position = config.calculatePosition(trigger, createWindowInfo(), {
            width: config.width,
            height: 200,
        });

        expect(position).toEqual({
            x: 493,
            y: 205,
        });
    });

    it('right-aligns and clamps session history popups when they are triggered from the session panel', async () => {
        const { initializeBuiltInPopups, popupRegistry } = await loadRegistryModule();
        initializeBuiltInPopups();

        const trigger = document.createElement('button');
        defineRect(trigger, { top: 320, right: 260, bottom: 350, left: 220 });
        document.body.appendChild(trigger);

        const config = popupRegistry.get('session-history-popup');
        expect(config).toBeDefined();
        if (!config) {
            throw new Error('Expected session history popup config');
        }
        const position = config.calculatePosition(
            trigger,
            createWindowInfo({
                position: { x: 400, y: 100 },
                screenPosition: { x: 400, y: 0 },
                screenSize: { width: 320, height: 520 },
            }),
            {
                width: config.width,
                height: 160,
            }
        );

        expect(position).toEqual({
            x: 400,
            y: 255,
        });
    });
});
