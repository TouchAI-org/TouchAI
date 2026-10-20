<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    /**
     * 用量页的骨架屏。
     *
     * 不用全局 `LoadingState`：那个组件把品牌动画居中放在整块区域里，
     * 在内容密集的页面上会显得突兀，也让布局在加载完成时跳一下。
     * 骨架屏保持与真实内容一致的骨架，加载完成时位置不变。
     */
    defineOptions({ name: 'UsageSkeleton' });
</script>

<template>
    <div class="space-y-3" data-testid="settings-usage-skeleton" aria-hidden="true">
        <!-- 仪表盘：标题 + 指标卡 + 曲线 -->
        <div class="space-y-3">
            <div class="flex items-center justify-between">
                <div class="h-3 w-16 animate-pulse rounded bg-neutral-100" />
                <div class="h-6 w-20 animate-pulse rounded bg-neutral-100" />
            </div>

            <div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <div
                    v-for="index in 5"
                    :key="index"
                    class="flex flex-col gap-2 rounded-[10px] bg-neutral-50/80 px-4 py-3"
                >
                    <div class="h-3 w-12 animate-pulse rounded bg-neutral-200/70" />
                    <div class="h-6 w-20 animate-pulse rounded bg-neutral-200/70" />
                    <div class="h-2.5 w-16 animate-pulse rounded bg-neutral-200/50" />
                </div>
            </div>

            <div class="rounded-[11px] bg-neutral-50/80 p-3">
                <div class="h-2.5 w-24 animate-pulse rounded bg-neutral-200/70" />
                <div class="mt-2 h-[96px] animate-pulse rounded bg-neutral-200/40" />
            </div>
        </div>

        <!-- 趋势与分布 -->
        <div class="settings-row-group p-4">
            <div class="flex items-center justify-between">
                <div class="h-3 w-24 animate-pulse rounded bg-neutral-100" />
                <div class="h-6 w-40 animate-pulse rounded bg-neutral-100" />
            </div>
            <div class="mt-3 h-[168px] animate-pulse rounded bg-neutral-100/70" />
            <div class="mt-3 flex justify-center gap-5">
                <div
                    v-for="index in 4"
                    :key="index"
                    class="h-2.5 w-20 animate-pulse rounded bg-neutral-100"
                />
            </div>
        </div>

        <!-- 工具调用 -->
        <div class="space-y-3">
            <div class="h-3 w-16 animate-pulse rounded bg-neutral-100" />
            <div class="settings-row-group p-4">
                <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <div
                        v-for="index in 4"
                        :key="index"
                        class="flex flex-col gap-2 rounded-[10px] bg-neutral-50/80 px-4 py-3"
                    >
                        <div class="h-3 w-12 animate-pulse rounded bg-neutral-200/70" />
                        <div class="h-6 w-16 animate-pulse rounded bg-neutral-200/70" />
                    </div>
                </div>
            </div>
        </div>

        <!-- 热力图 -->
        <div class="space-y-3">
            <div class="h-3 w-16 animate-pulse rounded bg-neutral-100" />
            <div class="settings-row-group p-4">
                <div class="h-[96px] animate-pulse rounded bg-neutral-100/70" />
            </div>
        </div>
    </div>
</template>
