import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { ToolCallInfo } from '@/types/session';
import BuiltInApplyPatchToolCallItem from '@/views/SearchView/components/ConversationPanel/components/BuiltInApplyPatchToolCallItem.vue';

function createToolCall(): ToolCallInfo {
    return {
        id: 'call-1',
        name: 'ApplyPatch',
        namespacedName: 'builtin__apply_patch',
        source: 'builtin',
        sourceLabel: '内置工具',
        arguments: {},
        status: 'completed',
        result: [
            '已在 D:/project 应用补丁',
            '- 修改 src/example.ts',
            '',
            '<<<APPLY_PATCH_RESULT',
            JSON.stringify({
                workingDirectory: 'D:/project',
                changedFiles: [
                    {
                        path: 'src/example.ts',
                        newPath: null,
                        operation: 'update',
                        preview: {
                            beforeContent: 'same line\nconst value = 2;\nkept line\n',
                            afterContent: 'same line\nconst value = 1;\nkept line\n',
                            beforeTruncated: false,
                            afterTruncated: false,
                            isBinary: false,
                            omitted: false,
                        },
                    },
                    {
                        path: 'src/new.ts',
                        newPath: null,
                        operation: 'add',
                        preview: {
                            beforeContent: null,
                            afterContent: 'created\n',
                            beforeTruncated: false,
                            afterTruncated: false,
                            isBinary: false,
                            omitted: false,
                        },
                    },
                ],
            }),
            'APPLY_PATCH_RESULT>>>',
        ].join('\n'),
        isError: false,
        durationMs: 45,
    };
}

describe('BuiltInApplyPatchToolCallItem', () => {
    it('renders file previews after expansion and switches selected file', async () => {
        const wrapper = mount(BuiltInApplyPatchToolCallItem, {
            props: {
                toolCall: createToolCall(),
                verbText: '已更新',
                summaryText: '修改 src/example.ts',
                durationText: '45ms',
            },
        });

        await wrapper.get('button.tool-call-log-button').trigger('click');

        expect(wrapper.text()).toContain('D:/project');
        expect(wrapper.text()).toContain('变更预览');
        expect(wrapper.text()).toContain('+1 -1');
        expect(wrapper.find('.tool-call-apply-patch-preview-grid').exists()).toBe(false);

        const contextRow = wrapper.find('.tool-call-apply-patch-diff-row--context');
        expect(contextRow.text()).toContain('same line');
        expect(
            contextRow.findAll('.tool-call-apply-patch-diff-line-number').map((node) => node.text())
        ).toEqual(['1', '1']);

        const removeRow = wrapper.find('.tool-call-apply-patch-diff-row--remove');
        expect(removeRow.find('.tool-call-apply-patch-diff-prefix').text()).toBe('-');
        expect(
            removeRow.findAll('.tool-call-apply-patch-diff-line-number').map((node) => node.text())
        ).toEqual(['2', '']);
        expect(removeRow.find('.tool-call-apply-patch-diff-text').text()).toBe('const value = 2;');
        expect(removeRow.find('.tool-call-apply-patch-diff-inline-change').text()).toBe('2');

        const addRow = wrapper.find('.tool-call-apply-patch-diff-row--add');
        expect(addRow.find('.tool-call-apply-patch-diff-prefix').text()).toBe('+');
        expect(
            addRow.findAll('.tool-call-apply-patch-diff-line-number').map((node) => node.text())
        ).toEqual(['', '2']);
        expect(addRow.find('.tool-call-apply-patch-diff-text').text()).toBe('const value = 1;');
        expect(addRow.find('.tool-call-apply-patch-diff-inline-change').text()).toBe('1');

        const fileButtons = wrapper.findAll('button.tool-call-apply-patch-file');
        await fileButtons[1]!.trigger('click');

        expect(wrapper.text()).toContain('src/new.ts');
        expect(wrapper.text()).toContain('+1 -0');
        expect(wrapper.text()).toContain('created');
        expect(wrapper.find('.tool-call-apply-patch-diff-row--add').text()).toContain('created');
    });
});
