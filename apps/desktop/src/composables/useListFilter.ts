// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { Ref } from 'vue';
import { computed, ref } from 'vue';

interface UseListFilterOptions<T> {
    /** 源数据 */
    items: Ref<T[]> | (() => T[]);
    /** 从项目中提取状态值的函数 */
    getStatus?: (item: T) => string | boolean;
    /** 从项目中提取可搜索文本的函数，返回多个字段用于匹配 */
    getSearchableText: (item: T) => (string | null | undefined)[];
}

/**
 * 通用列表筛选 composable
 * 提供状态筛选和关键词搜索能力
 */
export function useListFilter<T>(options: UseListFilterOptions<T>) {
    const filterStatus = ref<string>('all');
    const searchQuery = ref('');

    const sourceItems = computed(() => {
        const src = options.items;
        return typeof src === 'function' ? src() : src.value;
    });

    const filteredItems = computed(() => {
        let result = sourceItems.value;

        // 按状态筛选
        if (filterStatus.value !== 'all' && options.getStatus) {
            result = result.filter((item) => {
                const status = options.getStatus!(item);
                if (typeof status === 'boolean') {
                    return filterStatus.value === 'enabled' ? status : !status;
                }
                return status === filterStatus.value;
            });
        }

        // 按搜索关键词筛选
        if (searchQuery.value.trim()) {
            const query = searchQuery.value.toLowerCase();
            result = result.filter((item) =>
                options.getSearchableText(item).some((text) => text?.toLowerCase().includes(query))
            );
        }

        return result;
    });

    return {
        filterStatus,
        searchQuery,
        filteredItems,
    };
}
