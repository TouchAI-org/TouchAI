import type { Editor, JSONContent } from '@tiptap/core';
import { computed, type Ref, ref, type ShallowRef } from 'vue';

import {
    clearEditorSkipSync,
    DEFAULT_PLACEHOLDER,
    getEditorJSON,
    setEditorJSON,
} from '../utils/tiptap';

interface UseModelSearchSessionOptions {
    searchQuery: Ref<string>;
    editor: ShallowRef<Editor | null>;
}

interface SelectionRestoreSnapshot {
    wasSearching: boolean;
    savedEditorJSON: JSONContent | null;
}

/**
 * 模型搜索会话状态。
 * 负责管理进入/退出模型搜索时的输入快照、占位文案与下拉筛选词，
 *
 * @param options 模型搜索会话依赖的编辑器与输入状态。
 * @returns 会话状态与恢复控制方法。
 */
export function useModelSearchSession(options: UseModelSearchSessionOptions) {
    const { searchQuery, editor } = options;

    const savedEditorJSON = ref<JSONContent | null>(null);
    const isSearchingModel = ref(false);
    const isModelDropdownOpen = ref(false);
    const dropdownSearchQuery = ref('');

    const currentPlaceholder = computed(() => {
        return isSearchingModel.value ? '请输入模型名称或ID' : DEFAULT_PLACEHOLDER;
    });

    /**
     * 退出模型搜索模式后恢复原输入，避免用户切换模型时丢失已写草稿。
     *
     * @returns void
     */
    function restoreSearchState() {
        if (!isSearchingModel.value) {
            return;
        }

        const ed = editor.value;
        if (ed && savedEditorJSON.value) {
            setEditorJSON(ed, savedEditorJSON.value);
        } else {
            searchQuery.value = '';
        }

        isSearchingModel.value = false;
        savedEditorJSON.value = null;

        setTimeout(() => {
            editor.value?.commands.focus('end');
        }, 0);
    }

    /**
     * 重置模型搜索状态。
     *
     * @returns void
     */
    function resetModelDropdownState() {
        isModelDropdownOpen.value = false;
        dropdownSearchQuery.value = '';
        restoreSearchState();
    }

    /**
     * 进入模型搜索模式前先保存当前草稿。
     * 使用 clearEditorSkipSync 避免清空编辑器时误触发 model tag 同步回收。
     *
     * @returns void
     */
    function enterModelSearchMode() {
        const ed = editor.value;
        if (ed) {
            savedEditorJSON.value = getEditorJSON(ed);
            clearEditorSkipSync(ed);
        }

        searchQuery.value = '';
        isSearchingModel.value = true;
        dropdownSearchQuery.value = '';
        isModelDropdownOpen.value = true;

        setTimeout(() => {
            editor.value?.commands.focus();
        }, 100);
    }

    /**
     * 在模型选择提交前先摘除搜索会话状态。
     * 这样恢复编辑器快照时，onUpdate 就不会再把文本变化当作 popup 查询继续回写。
     *
     * @returns 恢复编辑器所需的快照。
     */
    function captureSelectionRestoreSnapshot(): SelectionRestoreSnapshot {
        const snapshot = {
            wasSearching: isSearchingModel.value,
            savedEditorJSON: savedEditorJSON.value,
        };

        isSearchingModel.value = false;
        isModelDropdownOpen.value = false;
        dropdownSearchQuery.value = '';
        savedEditorJSON.value = null;

        return snapshot;
    }

    /**
     * 根据捕获的快照恢复编辑器内容。
     * 只在确实来自模型搜索会话时恢复，避免覆盖正常输入路径。
     *
     * @param snapshot 模型选择前捕获的会话快照。
     * @returns void
     */
    function restoreEditorFromSnapshot(snapshot: SelectionRestoreSnapshot) {
        if (!snapshot.wasSearching || !snapshot.savedEditorJSON) {
            return;
        }

        const ed = editor.value;
        if (!ed) {
            return;
        }

        setEditorJSON(ed, snapshot.savedEditorJSON);
    }

    /**
     * 同步当前 dropdown 搜索词，供 popup 内容刷新使用。
     *
     * @param query 模型下拉查询词。
     * @returns void
     */
    function updateDropdownSearchQuery(query: string) {
        dropdownSearchQuery.value = query;
    }

    return {
        currentPlaceholder,
        isSearchingModel,
        isModelDropdownOpen,
        dropdownSearchQuery,
        restoreSearchState,
        resetModelDropdownState,
        enterModelSearchMode,
        captureSelectionRestoreSnapshot,
        restoreEditorFromSnapshot,
        updateDropdownSearchQuery,
    };
}
