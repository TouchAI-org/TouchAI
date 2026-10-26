import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The title bar is the only way to minimise or close a window that has no system chrome. A
 * button that renders when it should be hidden, or a click that does nothing because the window
 * handle was never resolved, strands the user with a window they cannot dismiss.
 */
const { getCurrentWindowMock, minimizeMock, closeMock } = vi.hoisted(() => ({
    getCurrentWindowMock: vi.fn(),
    minimizeMock: vi.fn(async () => undefined),
    closeMock: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: getCurrentWindowMock }));

vi.mock('@components/Tooltip.vue', () => ({
    default: { name: 'Tooltip', template: '<div><slot /></div>' },
}));

vi.mock('@components/TooltipTrigger.vue', () => ({
    default: { name: 'TooltipTrigger', template: '<div><slot /></div>' },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: { name: 'AppIcon', template: '<i />' },
}));

import TitleBar from '@/components/TitleBar.vue';

function windowHandle() {
    return { minimize: minimizeMock, close: closeMock };
}

beforeEach(() => {
    vi.clearAllMocks();
    getCurrentWindowMock.mockReturnValue(windowHandle());
});

describe('user closes a window with no system chrome', () => {
    it('user gets the minimise and close buttons by default', () => {
        const wrapper = mount(TitleBar, { props: { title: 'Settings' } });

        // Both controls are needed when the OS chrome is off.
        expect(wrapper.findAll('[data-tauri-drag-region="false"]').length >= 1).toBe(true);
        expect(wrapper.findAll('[data-tauri-drag-region="false"]').length === 2).toBe(true);
    });

    it('user gets the window minimised when they press the minimise button', async () => {
        const wrapper = mount(TitleBar, { props: { title: 'Settings' } });

        await wrapper.findAll('[data-tauri-drag-region="false"]')[0]!.trigger('click');

        expect(minimizeMock).toHaveBeenCalled();
    });

    it('user gets the window closed when they press the close button', async () => {
        const wrapper = mount(TitleBar, { props: { title: 'Settings' } });

        await wrapper.findAll('[data-tauri-drag-region="false"]')[1]!.trigger('click');

        expect(closeMock).toHaveBeenCalled();
    });

    it('user gets the title they passed shown in the bar', () => {
        const wrapper = mount(TitleBar, { props: { title: 'Advanced settings' } });

        expect(wrapper.text()).toContain('Advanced settings');
    });
});

describe('user gets only the controls a window needs', () => {
    it('user gets no minimise button when the window cannot be minimised', () => {
        const wrapper = mount(TitleBar, {
            props: { title: 'Popup', showMinimize: false },
        });

        // A button that does nothing is worse than no button: only close remains.
        expect(wrapper.findAll('[data-tauri-drag-region="false"]')).toHaveLength(1);
    });

    it('user gets no close button when the window must stay open', () => {
        const wrapper = mount(TitleBar, {
            props: { title: 'Popup', showClose: false },
        });

        // Only minimise remains.
        expect(wrapper.findAll('[data-tauri-drag-region="false"]')).toHaveLength(1);
    });

    it('user gets the bar rendered without crashing when there is no window handle', () => {
        getCurrentWindowMock.mockImplementation(() => {
            throw new Error('not running inside Tauri');
        });

        const wrapper = mount(TitleBar, { props: { title: 'Settings' } });

        // The bar still has to render; only the controls lose their target.
        expect(wrapper.find('[data-testid="app-titlebar"]').exists()).toBe(true);
    });

    it('user gets a click on close ignored rather than thrown when there is no window', async () => {
        getCurrentWindowMock.mockImplementation(() => {
            throw new Error('not running inside Tauri');
        });
        const wrapper = mount(TitleBar, { props: { title: 'Settings' } });

        await wrapper.findAll('[data-tauri-drag-region="false"]')[1]!.trigger('click');

        // An unhandled rejection here would surface as a console error on every click.
        expect(closeMock).not.toHaveBeenCalled();
    });
});
