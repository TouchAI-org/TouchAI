import { mountComposable } from '@tests/utils/composables';
import { afterEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useDragging } from '@/views/SearchView/components/SearchBar/composables/useDragging';
import { useModelSelection } from '@/views/SearchView/components/SearchBar/composables/useModelSelection';
import { useSearchInput } from '@/views/SearchView/components/SearchBar/composables/useSearchLogic';

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

it('user opens a filter after restoring editor focus, then delayed frames keep focus in the filter', async () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        frames.push(callback)
    );
    const host = document.createElement('div');
    const filter = document.createElement('input');
    document.body.append(host, filter);
    const { result, unmount } = await mountComposable(() =>
        useSearchInput(
            {
                searchBarContainerRef: ref(host),
                editorHostRef: ref(host),
                queryText: ref(''),
                attachments: ref([]),
                modelOverride: ref({ modelId: null, providerId: null }),
                emitQueryText: vi.fn(),
                emitModelChange: vi.fn(),
                emitModelOverrideChange: vi.fn(),
                emitRemoveAttachmentRequest: vi.fn(),
                emitDragStart: vi.fn(),
                emitDragEnd: vi.fn(),
                startDragging: vi.fn().mockResolvedValue(undefined),
            },
            {
                createDragging: useDragging,
                createModelSelection: (options) =>
                    useModelSelection(options, {
                        findModels: async () => [],
                        getActiveModel: async () => null,
                        findModelByOverride: async () => null,
                    }),
            }
        )
    );

    try {
        result.initEditor();
        host.append(result.editor.value!.view.dom);
        await result.focus();
        filter.focus();
        await vi.runOnlyPendingTimersAsync();
        for (const callback of frames.splice(0)) callback(16);

        expect(document.activeElement).toBe(filter);
        await result.focus();
        expect(document.activeElement).toBe(result.editor.value!.view.dom);
    } finally {
        result.destroyEditor();
        unmount();
    }
});
