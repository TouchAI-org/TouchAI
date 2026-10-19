<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->
<template>
    <span
        aria-hidden="true"
        class="flex shrink-0 items-center justify-center overflow-hidden rounded-full leading-none"
        :class="imageAvailable ? '' : 'font-bold text-white uppercase select-none'"
        :style="tileStyle"
    >
        <img
            v-if="imageAvailable"
            :src="currentSrc"
            alt=""
            draggable="false"
            class="size-full object-cover"
            @error="advance"
            @load="rememberLoaded"
        />
        <template v-else>{{ initial }}</template>
    </span>
</template>

<script setup lang="ts">
    import { computed, ref, watch } from 'vue';

    import { webSearchSiteName } from '@/services/BuiltInToolService/tools/webSearch/sources';

    import { buildFaviconCandidates, faviconHost, rememberFavicon } from './favicon';

    interface Props {
        /** 只需要站点名与可选图标，让引用与卡片复用同一份展示逻辑。 */
        source: { url: string; favicon?: string };
        size: number;
    }

    const props = defineProps<Props>();

    const candidates = ref(buildFaviconCandidates(props.source));
    const candidateIndex = ref(0);

    const currentSrc = computed(() => candidates.value[candidateIndex.value] ?? '');
    const hasIcon = computed(() => candidates.value.length > 0);
    const imageAvailable = computed(() => hasIcon.value && Boolean(currentSrc.value));
    const siteName = computed(() => webSearchSiteName(props.source.url));
    const initial = computed(() => siteName.value.charAt(0));

    /** 没有图标时用站点名散列出色相，保证同一站点每次颜色一致。 */
    const hue = computed(() => {
        let hash = 2166136261;
        for (let index = 0; index < siteName.value.length; index += 1) {
            hash = Math.imul(hash ^ siteName.value.charCodeAt(index), 16777619);
        }
        return (hash >>> 0) % 360;
    });

    const tileStyle = computed(() => ({
        width: `${props.size}px`,
        height: `${props.size}px`,
        fontSize: `${props.size * 0.5}px`,
        background: imageAvailable.value
            ? undefined
            : `linear-gradient(135deg, oklch(0.72 0.15 ${hue.value}), oklch(0.58 0.17 ${(hue.value + 30) % 360}))`,
    }));

    watch(
        () => [props.source.url, props.source.favicon],
        () => {
            candidates.value = buildFaviconCandidates(props.source);
            candidateIndex.value = 0;
        }
    );

    /** 当前候选失败：换下一个；全部失败则回退到字母块。 */
    function advance(): void {
        if (candidateIndex.value < candidates.value.length - 1) {
            candidateIndex.value += 1;
            return;
        }

        candidates.value = [];
        candidateIndex.value = 0;
    }

    function rememberLoaded(): void {
        rememberFavicon(faviconHost(props.source.url), currentSrc.value);
    }
</script>
