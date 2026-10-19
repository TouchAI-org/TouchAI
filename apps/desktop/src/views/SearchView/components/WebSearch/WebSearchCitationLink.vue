<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->
<template>
    <WebSearchCitation v-if="matchedSource" :source="matchedSource" :index="matchedIndex" />
    <a
        v-else
        :href="node.href"
        target="_blank"
        rel="noreferrer"
        class="touchai-markdown-link"
        v-text="linkText"
    ></a>
</template>

<script setup lang="ts">
    import { computed, inject } from 'vue';

    import { isExternalHttpUrl, WEB_SEARCH_CITATIONS_KEY } from './citations';
    import WebSearchCitation from './WebSearchCitation.vue';

    /**
     * 与 `markstream-vue` 的 `link` 自定义节点契约一致。
     *
     * 这里只接管"命中本次搜索来源"的外部链接，其余链接透传成普通 `<a>`，
     * 避免破坏现有的链接样式与点击行为。
     */
    interface Props {
        node: {
            type: 'link';
            href: string;
            title?: string | null;
            text?: string;
            raw?: string;
        };
    }

    const props = defineProps<Props>();

    const registry = inject(WEB_SEARCH_CITATIONS_KEY, null);

    const matchedSource = computed(() => {
        if (!registry || !isExternalHttpUrl(props.node.href)) {
            return undefined;
        }
        return registry.findByUrl(props.node.href);
    });

    const matchedIndex = computed(() =>
        matchedSource.value ? registry?.indexOf(matchedSource.value) : undefined
    );

    /** 链接文本优先取节点自带的 text，回退到去掉标记的 raw。 */
    const linkText = computed(
        () => props.node.text || props.node.title || props.node.raw || props.node.href
    );
</script>
