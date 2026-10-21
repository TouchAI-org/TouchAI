<script setup lang="ts">
    /**
     * 用量页的骨架屏。
     *
     * 不用全局 `LoadingState`：那个组件把品牌动画居中放在整块区域里，
     * 在内容密集的页面上会显得突兀，也让布局在加载完成时跳一下。
     *
     * 每块高度不再手写：真实内容渲染后会量出各块高度并缓存，
     * 这里直接套用（`blockHeights`），所以改字号、加卡片都不会让骨架跑偏。
     * 首次访问没有缓存时退回自身内容撑开。
     */
    defineOptions({ name: 'UsageSkeleton' });

    const props = withDefaults(defineProps<{ blockHeights?: number[] }>(), {
        blockHeights: () => [],
    });

    /** 第 index 块的最小高度；没有量测值时不限制 */
    function minHeightOf(index: number): string | undefined {
        const height = props.blockHeights[index];
        return height && height > 0 ? `${height}px` : undefined;
    }
</script>

<template>
    <div class="settings-section-stack" data-testid="settings-usage-skeleton" aria-hidden="true">
        <!-- 仪表盘：六张主卡 + 次级小卡 + 曲线（顶部没有标题行） -->
        <div class="space-y-3 pb-1" :style="{ minHeight: minHeightOf(0) }">
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div
                    v-for="index in 6"
                    :key="index"
                    class="flex flex-col gap-1 rounded-[10px] bg-neutral-50/80 px-4 py-3"
                >
                    <div class="h-3 w-16 animate-pulse rounded bg-neutral-200/70" />
                    <div class="h-6 w-20 animate-pulse rounded bg-neutral-200/70" />
                    <div class="h-2.5 w-14 animate-pulse rounded bg-neutral-200/50" />
                </div>
            </div>

            <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <div
                    v-for="index in 6"
                    :key="index"
                    class="flex flex-col gap-0.5 rounded-[9px] bg-neutral-50/60 px-3 py-2"
                >
                    <div class="h-2.5 w-12 animate-pulse rounded bg-neutral-200/70" />
                    <div class="h-4 w-16 animate-pulse rounded bg-neutral-200/70" />
                </div>
            </div>

            <div class="rounded-[11px] bg-neutral-50/80 p-3">
                <div class="flex items-start justify-between">
                    <div class="h-2.5 w-28 animate-pulse rounded bg-neutral-200/70" />
                    <div class="h-4 w-14 animate-pulse rounded bg-neutral-200/60" />
                </div>
                <div class="mt-1 h-[96px] animate-pulse rounded bg-neutral-200/40" />
            </div>
        </div>

        <!-- 使用趋势与分布：小标题在卡外，卡内是柱状图 + 居中图例 -->
        <div class="space-y-3" :style="{ minHeight: minHeightOf(1) }">
            <div class="flex items-center justify-between gap-2">
                <div class="h-4 w-28 animate-pulse rounded bg-neutral-200/70" />
                <div class="h-6 w-56 animate-pulse rounded bg-neutral-200/50" />
            </div>
            <div class="rounded-[11px] bg-neutral-50/80 p-4">
                <div class="h-[168px] animate-pulse rounded bg-neutral-200/40" />
                <div class="mt-3 flex justify-center gap-5">
                    <div
                        v-for="index in 4"
                        :key="index"
                        class="h-2.5 w-20 animate-pulse rounded bg-neutral-200/60"
                    />
                </div>
            </div>
        </div>

        <!-- Token 构成与耗时构成：两张并排的环图卡 -->
        <div class="grid grid-cols-1 gap-3 xl:grid-cols-2" :style="{ minHeight: minHeightOf(2) }">
            <div v-for="index in 2" :key="index" class="space-y-3">
                <div class="flex items-baseline justify-between gap-2">
                    <div class="h-4 w-20 animate-pulse rounded bg-neutral-200/70" />
                    <div class="h-2.5 w-32 animate-pulse rounded bg-neutral-200/50" />
                </div>
                <div class="rounded-[11px] bg-neutral-50/80 p-4">
                    <div class="flex items-center gap-5">
                        <div
                            class="h-[96px] w-[96px] shrink-0 animate-pulse rounded-full bg-neutral-200/60"
                        />
                        <div class="grid min-w-0 flex-1 grid-cols-2 gap-x-5 gap-y-2.5">
                            <div v-for="row in 6" :key="row" class="flex flex-col gap-1">
                                <div class="h-2.5 w-full animate-pulse rounded bg-neutral-200/60" />
                                <div class="h-2 w-12 animate-pulse rounded bg-neutral-200/40" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 工具调用：标题 + 描述，卡内四个指标 + 表格 -->
        <div class="space-y-3" :style="{ minHeight: minHeightOf(3) }">
            <div class="space-y-2">
                <div class="h-4 w-16 animate-pulse rounded bg-neutral-200/70" />
                <div class="h-2.5 w-64 animate-pulse rounded bg-neutral-200/50" />
            </div>
            <div class="rounded-[11px] bg-neutral-50/80 p-4">
                <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <div
                        v-for="index in 4"
                        :key="index"
                        class="flex flex-col gap-1 rounded-[10px] bg-white/70 px-4 py-3"
                    >
                        <div class="h-3 w-14 animate-pulse rounded bg-neutral-200/70" />
                        <div class="h-6 w-16 animate-pulse rounded bg-neutral-200/70" />
                    </div>
                </div>
            </div>
            <div class="space-y-3 rounded-[11px] bg-neutral-50/80 p-4">
                <div v-for="row in 5" :key="row" class="flex items-center gap-4">
                    <div class="h-3 flex-1 animate-pulse rounded bg-neutral-200/60" />
                    <div class="h-3 w-10 animate-pulse rounded bg-neutral-200/50" />
                    <div class="h-3 w-10 animate-pulse rounded bg-neutral-200/50" />
                    <div class="h-3 w-10 animate-pulse rounded bg-neutral-200/50" />
                </div>
            </div>
        </div>

        <!-- 模型与会话排行：小标题在卡外，两张并排 -->
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2" :style="{ minHeight: minHeightOf(4) }">
            <div v-for="index in 2" :key="index" class="space-y-2">
                <div class="flex items-center justify-between gap-3">
                    <div class="h-4 w-16 animate-pulse rounded bg-neutral-200/70" />
                    <div class="h-5 w-24 animate-pulse rounded bg-neutral-200/50" />
                </div>
                <div class="rounded-[11px] bg-neutral-50/80 p-3">
                    <div class="space-y-2">
                        <div v-for="row in 3" :key="row" class="space-y-1">
                            <div class="flex items-baseline gap-2">
                                <div class="h-2.5 flex-1 animate-pulse rounded bg-neutral-200/60" />
                                <div class="h-2.5 w-8 animate-pulse rounded bg-neutral-200/50" />
                            </div>
                            <div class="h-[5px] animate-pulse rounded-full bg-neutral-200/60" />
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 使用热力图：短区间是小时×日期，这里按一行高铺开 -->
        <div class="space-y-3" :style="{ minHeight: minHeightOf(5) }">
            <div class="flex items-baseline justify-between gap-2">
                <div class="h-4 w-20 animate-pulse rounded bg-neutral-200/70" />
                <div class="h-2.5 w-40 animate-pulse rounded bg-neutral-200/50" />
            </div>
            <div class="rounded-[11px] bg-neutral-50/80 p-4">
                <div class="h-[30px] animate-pulse rounded bg-neutral-200/40" />
                <div class="mt-2 flex items-center gap-1.5">
                    <div class="h-2.5 w-4 animate-pulse rounded bg-neutral-200/60" />
                    <div
                        v-for="index in 5"
                        :key="index"
                        class="h-2.5 w-2.5 animate-pulse rounded-sm bg-neutral-200/70"
                    />
                    <div class="h-2.5 w-4 animate-pulse rounded bg-neutral-200/60" />
                </div>
            </div>
        </div>
    </div>
</template>
