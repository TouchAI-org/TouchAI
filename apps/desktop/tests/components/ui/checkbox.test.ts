import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { Checkbox } from '@/components/ui/checkbox';

describe('given a selection checkbox', () => {
    it.each([false, true, 'indeterminate'] as const)(
        'user sees the selection state and consistent styling when checked is %s',
        (state) => {
            const view = mount(Checkbox, { props: { modelValue: state } });
            const checkbox = view.get('button');
            expect(checkbox.attributes('aria-checked')).toBe(
                state === 'indeterminate' ? 'mixed' : String(state)
            );
            expect(checkbox.classes().sort()).toMatchSnapshot();
            view.unmount();
        }
    );

    it('user selects an unchecked item and receives the checked value', async () => {
        const view = mount(Checkbox, { props: { modelValue: false } });
        await view.get('button').trigger('click');
        expect(view.emitted('update:modelValue')).toEqual([[true]]);
        view.unmount();
    });

    it('user tries to select a disabled item and its value stays unchanged', async () => {
        const view = mount(Checkbox, { props: { modelValue: false, disabled: true } });
        await view.get('button').trigger('click');
        expect(view.emitted('update:modelValue')).toBeUndefined();
        view.unmount();
    });
});
