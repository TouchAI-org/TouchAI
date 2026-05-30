import { shallowMount } from '@vue/test-utils';
import { vi } from 'vitest';

import Sonner from '@/components/ui/sonner/Sonner.vue';

vi.mock('vue-sonner', () => ({
    Toaster: {
        name: 'Toaster',
        props: ['position', 'duration', 'closeButton', 'offset', 'toastOptions'],
        template: '<div data-testid="sonner-toaster" />',
    },
}));

describe('Settings toast positioning', () => {
    it('keeps top-center notifications below the draggable title bar', () => {
        const wrapper = shallowMount(Sonner);
        const toaster = wrapper.getComponent({ name: 'Toaster' });

        expect(toaster.props('position')).toBe('top-center');
        expect(toaster.props('offset')).toMatchObject({ top: 56 });
    });
});
