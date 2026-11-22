<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->
<template>
    <WebSearchCitation v-if="matchedSource" :source="matchedSource" />
    <!--
        未命中的链接交回 markstream 的 LinkNode 渲染：
        它会保留 `node.children` 里的行内格式（粗体、代码等），
        也自带 URL 与属性净化；自己拼 `<a v-text>` 两样都会丢。
        外链前面补一个站点图标，让正文链接和引用一样能一眼看出指向哪个站点。
    -->
    <span v-else-if="showsSiteIcon" class="web-search-link">
        <span class="web-search-link__icon">
            <SourceFavicon :source="{ url: node.href }" :size="14" />
        </span>
        <LinkNode :node="node" :index-key="indexKey" :custom-id="customId" />
    </span>
    <LinkNode v-else :node="node" :index-key="indexKey" :custom-id="customId" />
</template>

<script setup lang="ts">
    import { LinkNode, type LinkNodeProps } from 'markstream-vue';
    import { computed, inject } from 'vue';

    import { isExternalHttpUrl, WEB_SEARCH_CITATIONS_KEY } from './citations';
    import SourceFavicon from './SourceFavicon.vue';
    import WebSearchCitation from './WebSearchCitation.vue';

    /** 与 `markstream-vue` 的 `link` 自定义节点契约一致。 */
    interface Props {
        node: LinkNodeProps['node'];
        indexKey: number | string;
        customId?: string;
    }

    const props = defineProps<Props>();

    const registry = inject(WEB_SEARCH_CITATIONS_KEY, null);

    const isExternal = computed(() => isExternalHttpUrl(props.node.href));

    /** 只有命中本次搜索来源的外部链接才渲染成引用链接。 */
    const matchedSource = computed(() => {
        if (!registry || !isExternal.value) {
            return undefined;
        }
        return registry.findByUrl(props.node.href);
    });

    /** 页内锚点、相对路径和邮件链接没有站点图标可显示。 */
    const showsSiteIcon = computed(() => isExternal.value && !matchedSource.value);
</script>

<style scoped>
    .web-search-link {
        white-space: nowrap;
    }

    /* 图标是块级 flex 子项，包一层 inline-flex 才能跟在正文基线上。 */
    .web-search-link__icon {
        display: inline-flex;
        align-items: center;
        margin-inline-end: 0.28em;
        vertical-align: -0.16em;
    }
</style>
