import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import Button from '@/components/ui/button/Button.vue';

describe('given a conversation follow-up action', () => {
    it.each(['reply-primary', 'reply'] as const)(
        'user sees a consistent compact action with the %s treatment',
        (variant) => {
            const wrapper = mount(Button, {
                props: { variant },
                slots: { default: 'Compare regions' },
            });

            expect(wrapper.classes().sort()).toMatchSnapshot();
            expect(wrapper.attributes('type')).toBe('button');
            wrapper.unmount();
        }
    );
});
