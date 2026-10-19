<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->
<template>
    <WebSearchCitation v-if="matchedSource" :source="matchedSource" :index="matchedIndex" />
    <!--
        未命中的链接交回 markstream 的 LinkNode 渲染：
        它会保留 `node.children` 里的行内格式（粗体、代码等），
        也自带 URL 与属性净化；自己拼 `<a v-text>` 两样都会丢。
    -->
    <LinkNode v-else :node="node" :index-key="indexKey" :custom-id="customId" />
</template>

<script setup lang="ts">
    import { LinkNode, type LinkNodeProps } from 'markstream-vue';
    import { computed, inject } from 'vue';

    import { isExternalHttpUrl, WEB_SEARCH_CITATIONS_KEY } from './citations';
    import WebSearchCitation from './WebSearchCitation.vue';

    /** 与 `markstream-vue` 的 `link` 自定义节点契约一致。 */
    interface Props {
        node: LinkNodeProps['node'];
        indexKey: number | string;
        customId?: string;
    }

    const props = defineProps<Props>();

    const registry = inject(WEB_SEARCH_CITATIONS_KEY, null);

    /** 只有命中本次搜索来源的外部链接才渲染成引用 chip。 */
    const matchedSource = computed(() => {
        if (!registry || !isExternalHttpUrl(props.node.href)) {
            return undefined;
        }
        return registry.findByUrl(props.node.href);
    });

    const matchedIndex = computed(() =>
        matchedSource.value ? registry?.indexOf(matchedSource.value) : undefined
    );
</script>
