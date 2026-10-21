<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    /**
     * 仪表盘（首屏）的骨架。
     *
     * 只有首屏需要这一块：它必须在数据到达前占位，避免整页空白。
     * 下方各区块由组件自己画骨架——骨架和真实内容写在同一个组件里，
     * 改字号、加卡片都不会漂移，也不需要量高度或缓存。
     */
    defineOptions({ name: 'UsageDashboardSkeleton' });
</script>

<template>
    <section class="space-y-3 pb-1" data-testid="settings-usage-skeleton" aria-hidden="true">
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

        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
            <div
                v-for="index in 7"
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
    </section>
</template>
