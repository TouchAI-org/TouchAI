<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->
<template>
    <span
        aria-hidden="true"
        class="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full leading-none"
        :class="imageReady ? '' : 'font-bold text-white uppercase select-none'"
        :style="tileStyle"
    >
        <!--
            `<img>` 一旦有候选就挂上，否则永远等不到 load/error。
            「还没画出来」时先显示字母块，图片就绪后再淡入，避免闪白。
        -->
        <img
            v-if="imageAvailable"
            :src="currentSrc"
            alt=""
            draggable="false"
            class="size-full object-cover"
            :class="imageReady ? 'opacity-100' : 'opacity-0'"
            @error="advance"
            @load="rememberLoaded"
        />
        <span v-if="!imageReady" class="absolute inset-0 flex items-center justify-center">
            {{ initial }}
        </span>
    </span>
</template>

<script setup lang="ts">
    import { computed, ref, watch } from 'vue';

    import { webSearchSiteName } from '@/services/BuiltInToolService/tools/webSearch/sources';

    import {
        buildFaviconCandidates,
        faviconHost,
        isFaviconLoaded,
        rememberFavicon,
        rememberFaviconFailure,
        rememberFaviconLoaded,
    } from './favicon';

    interface Props {
        /** 只需要站点名与可选图标，让引用与卡片复用同一份展示逻辑。 */
        source: { url: string; favicon?: string };
        size: number;
    }

    const props = defineProps<Props>();

    const candidates = ref(buildFaviconCandidates(props.source));
    const candidateIndex = ref(0);
    /**
     * 当前候选是否已经画出来了。
     *
     * 正文每来一个 chunk 都会重解析 markdown，行内引用会随之重新挂载。
     * 若已经加载成功过的图标还要重新等一次 `load`，字母块就会跟着 chunk
     * 反复闪现（用户看到的就是图标在闪），所以成功过的直接当成就绪。
     */
    const imageReady = ref(isFaviconLoaded(candidates.value[0] ?? ''));

    const currentSrc = computed(() => candidates.value[candidateIndex.value] ?? '');
    const hasIcon = computed(() => candidates.value.length > 0);
    /** 有候选就挂 `<img>`，与是否已经画出来无关。 */
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
        background: imageReady.value
            ? undefined
            : `linear-gradient(135deg, oklch(0.72 0.15 ${hue.value}), oklch(0.58 0.17 ${(hue.value + 30) % 360}))`,
    }));

    /**
     * 只在 url / favicon 真正变化时才重建候选。
     *
     * 流式输出时父组件每个 chunk 都会下发新的 source 对象，
     * 若监听 `[url, favicon]` 这种每次求值都新建的数组，监听器会被无限触发：
     * 候选被反复重建 → 失败过的图标被重新挂上 `<img>` → 再次失败 → 回退字母块，
     * 用户看到的就是图标一直在闪。比较原始值可以完全避开这条路径。
     */
    watch(
        () => `${props.source.url}\u0000${props.source.favicon ?? ''}`,
        () => {
            const next = buildFaviconCandidates(props.source);
            if (
                next.length === candidates.value.length &&
                next.every((url, index) => url === candidates.value[index])
            ) {
                return;
            }

            candidates.value = next;
            candidateIndex.value = 0;
            imageReady.value = isFaviconLoaded(next[0] ?? '');
        }
    );

    /** 当前候选失败：换下一个；全部失败则回退到字母块。 */
    function advance(): void {
        // 失败要记住，否则组件重建 / 后续 chunk 会把这张图标重新试一遍。
        rememberFaviconFailure(currentSrc.value);
        imageReady.value = false;

        if (candidateIndex.value < candidates.value.length - 1) {
            candidateIndex.value += 1;
            imageReady.value = isFaviconLoaded(currentSrc.value);
            return;
        }

        candidates.value = [];
        candidateIndex.value = 0;
    }

    function rememberLoaded(): void {
        imageReady.value = true;
        rememberFaviconLoaded(currentSrc.value);
        rememberFavicon(faviconHost(props.source.url), currentSrc.value);
    }
</script>
