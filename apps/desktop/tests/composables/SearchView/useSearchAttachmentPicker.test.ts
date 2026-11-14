import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';

import type { Index } from '@/services/AgentService/infrastructure/attachments';
import { useSearchAttachmentPicker } from '@/views/SearchView/composables/useSearchAttachmentPicker';

function setup() {
    const openFiles = vi.fn<() => Promise<string[] | null>>();
    const createAttachment = vi.fn(
        async (type: 'image' | 'file', path: string) => ({ id: path, type, name: path }) as Index
    );
    const insertAttachment = vi.fn();
    const draftVersion = ref(0);
    let picker!: ReturnType<typeof useSearchAttachmentPicker>;
    const wrapper = mount(
        defineComponent({
            setup() {
                picker = useSearchAttachmentPicker({
                    openFiles,
                    createAttachment,
                    insertAttachment,
                    draftVersion,
                });
                return () => null;
            },
        })
    );
    return { openFiles, createAttachment, insertAttachment, draftVersion, picker, wrapper };
}

describe('given the native attachment picker', () => {
    it('user selects an image and a document and receives both in the current draft', async () => {
        const state = setup();
        state.openFiles.mockResolvedValue(['C:\\photo.png', 'C:\\notes.txt']);
        await state.picker.pickAttachments();
        expect(state.createAttachment.mock.calls).toEqual([
            ['image', 'C:\\photo.png'],
            ['file', 'C:\\notes.txt'],
        ]);
        expect(state.insertAttachment).toHaveBeenCalledTimes(2);
        expect(state.picker.error.value).toBe('');
        state.wrapper.unmount();
    });

    it('user cancels the file dialog and keeps the draft unchanged', async () => {
        const state = setup();
        state.openFiles.mockResolvedValue(null);
        await state.picker.pickAttachments();
        expect(state.insertAttachment).not.toHaveBeenCalled();
        expect(state.picker.busy.value).toBe(false);
        state.wrapper.unmount();
    });

    it('user changes drafts while files load and receives no stale attachments', async () => {
        const state = setup();
        state.openFiles.mockResolvedValue(['C:\\notes.txt']);
        let resolve!: (attachment: Index) => void;
        state.createAttachment.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                })
        );
        const pending = state.picker.pickAttachments();
        await flushPromises();
        state.draftVersion.value++;
        resolve({ id: 'late' } as Index);
        await pending;
        expect(state.insertAttachment).not.toHaveBeenCalled();
        state.wrapper.unmount();
    });

    it('user sees a failure, retains successful files, and can try again', async () => {
        const state = setup();
        state.openFiles.mockResolvedValue(['C:\\bad.txt', 'C:\\good.txt']);
        state.createAttachment.mockRejectedValueOnce(new Error('File unavailable'));
        await state.picker.pickAttachments();
        expect(state.picker.error.value).not.toBe('');
        expect(state.insertAttachment).toHaveBeenCalledTimes(1);
        state.openFiles.mockResolvedValue(['C:\\retry.txt']);
        await state.picker.pickAttachments();
        expect(state.picker.error.value).toBe('');
        expect(state.insertAttachment).toHaveBeenCalledTimes(2);
        state.wrapper.unmount();
    });
});
