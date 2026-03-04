import type QuickSearchPanel from '@components/search/QuickSearchPanel/index.vue';
import { computed, ref } from 'vue';

/**
 * 快捷搜索结果面板代理。
 * 负责持有面板实例并转发打开、关闭、导航与触发搜索等操作。
 *
 * @returns 快捷搜索面板实例引用与操作代理方法。
 */
export function useQuickShortcuts() {
    // 持有面板组件实例，父组件通过这里转发操作，不直接耦合内部实现。
    const quickSearchPanel = ref<InstanceType<typeof QuickSearchPanel>>();
    // 统一从面板暴露状态读取打开态，避免在父组件再维护一份重复状态。
    const isQuickSearchOpen = computed(() => {
        const panel = quickSearchPanel.value as
            | { isOpen?: boolean | { value?: boolean } }
            | undefined;
        const open = panel?.isOpen;
        if (typeof open === 'object' && open !== null && 'value' in open) {
            return Boolean(open.value);
        }
        return Boolean(open);
    });

    /**
     * 打开快速搜索面板。
     *
     * @returns void
     */
    function openQuickSearchPanel() {
        quickSearchPanel.value?.open();
    }

    /**
     * 关闭快速搜索面板。
     *
     * @returns void
     */
    function closeQuickSearchPanel() {
        quickSearchPanel.value?.close();
    }

    /**
     * 将面板高亮项向指定方向移动。
     *
     * @param direction 高亮移动方向。
     * @returns void
     */
    function moveQuickSearchSelection(direction: 'up' | 'down' | 'left' | 'right') {
        quickSearchPanel.value?.moveSelection(direction);
    }

    /**
     * 获取当前高亮的快捷项，若无则返回 null。
     *
     * @returns 当前高亮快捷项，若不存在则返回 null。
     */
    function getHighlightedQuickShortcut() {
        // 面板未挂载或无高亮项时返回 null，调用方按“无候选”分支处理。
        return quickSearchPanel.value?.getHighlightedItem() ?? null;
    }

    /**
     * 打开当前高亮项，等待内部异步打开流程完成。
     *
     * @returns Promise<void>
     */
    async function openHighlightedQuickShortcut() {
        // 打开动作可能包含异步资源加载，外层需要等待完成后再继续流程。
        await quickSearchPanel.value?.openHighlightedItem();
    }

    /**
     * 将输入查询转发给面板，触发面板内搜索流程。
     *
     * @param query 当前输入查询。
     * @returns void
     */
    function triggerQuickSearch(query: string) {
        quickSearchPanel.value?.triggerSearch(query);
    }

    return {
        quickSearchPanel,
        isQuickSearchOpen,
        openQuickSearchPanel,
        closeQuickSearchPanel,
        moveQuickSearchSelection,
        getHighlightedQuickShortcut,
        openHighlightedQuickShortcut,
        triggerQuickSearch,
    };
}
