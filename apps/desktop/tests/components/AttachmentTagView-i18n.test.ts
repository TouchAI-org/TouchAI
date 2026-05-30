import type { NodeViewProps } from '@tiptap/core';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import AttachmentTagView from '@/views/SearchView/components/SearchBar/tags/attachment/AttachmentTagView.vue';

vi.mock('@tiptap/vue-3', () => ({
    NodeViewWrapper: {
        name: 'NodeViewWrapper',
        props: ['as'],
        template: '<component :is="as || \'span\'"><slot /></component>',
    },
}));

function createNode(attrs: Record<string, unknown>): NodeViewProps['node'] {
    return {
        attrs: {
            attachmentId: 'attachment-1',
            fileName: '设置说明文件.txt',
            fileType: 'file',
            supportStatus: 'supported',
            ...attrs,
        },
    } as unknown as NodeViewProps['node'];
}

describe('AttachmentTagView i18n boundaries', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('marks attachment file text as not eligible for global DOM localization', () => {
        const wrapper = mount(AttachmentTagView, {
            props: {
                node: createNode({}),
                deleteNode: vi.fn(),
                decorations: [],
            },
        });

        expect(wrapper.attributes('data-no-i18n')).toBe('true');
        expect(wrapper.attributes('translate')).toBe('no');
        expect(wrapper.attributes('title')).toBe('设置说明文件.txt');

        const label = wrapper.get('.search-tag-label--attachment');
        expect(label.text()).toBe('设置说明文件.txt');
        expect(label.attributes('data-no-i18n')).toBe('true');
        expect(label.attributes('translate')).toBe('no');
    });

    it('marks attachment image alt text as not eligible for global DOM localization', () => {
        const wrapper = mount(AttachmentTagView, {
            props: {
                node: createNode({
                    fileName: '关闭按钮截图.png',
                    fileType: 'image',
                    preview: 'data:image/png;base64,abc',
                }),
                deleteNode: vi.fn(),
                decorations: [],
            },
        });

        const image = wrapper.get('img');
        expect(image.attributes('alt')).toBe('关闭按钮截图.png');
        expect(image.attributes('data-no-i18n')).toBe('true');
        expect(image.attributes('translate')).toBe('no');
    });

    it('localizes unsupported attachment tooltip suffix in English while preserving filename payload', () => {
        setLocale('en-US');

        const wrapper = mount(AttachmentTagView, {
            props: {
                node: createNode({
                    fileName: '设置截图.png',
                    fileType: 'image',
                    supportStatus: 'unsupported-image',
                }),
                deleteNode: vi.fn(),
                decorations: [],
            },
        });

        expect(wrapper.attributes('title')).toBe(
            '设置截图.png (current model does not support images)'
        );
    });
});
