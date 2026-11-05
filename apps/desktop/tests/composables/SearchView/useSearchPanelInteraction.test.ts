import { describe, expect, it, vi } from 'vitest';

import { useSearchPanelInteraction } from '@/views/SearchView/composables/useSearchPanelInteraction';

describe('useSearchPanelInteraction', () => {
    it('keeps the interaction active until overlapping drag and resize operations both end', () => {
        const onFirstStart = vi.fn();
        const onLastEnd = vi.fn();
        const interaction = useSearchPanelInteraction({ onFirstStart, onLastEnd });

        interaction.begin();
        interaction.begin();
        interaction.end();

        expect(interaction.active.value).toBe(true);
        expect(onFirstStart).toHaveBeenCalledTimes(1);
        expect(onLastEnd).not.toHaveBeenCalled();

        interaction.end();

        expect(interaction.active.value).toBe(false);
        expect(onLastEnd).toHaveBeenCalledTimes(1);
    });
});
