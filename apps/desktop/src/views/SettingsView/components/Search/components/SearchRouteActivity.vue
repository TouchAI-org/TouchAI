<script setup lang="ts">
    import { useMotion } from '@composables/useMotion';
    import { motion, useMotionValue, useTransform } from 'motion-v';
    import { computed, onScopeDispose, ref, watch } from 'vue';

    import type { WebSearchActivityEvent } from '@/app/api/windows/eventContracts';
    import SourceFavicon from '@/views/SearchView/components/WebSearch/SourceFavicon.vue';

    const props = defineProps<{ activity: WebSearchActivityEvent; path: string }>();
    const emit = defineEmits<{ complete: [] }>();
    const { duration } = useMotion();
    const stage = ref<'outbound' | 'waiting' | 'returning'>(
        props.activity.phase === 'results' ? 'returning' : 'outbound'
    );
    const offsetDistance = useMotionValue(props.activity.phase === 'results' ? '100%' : '0%');
    const progress = useTransform(offsetDistance, (value) => Number.parseFloat(value));
    const revealOnApproach = ref(false);
    const approachRange = ref([75, 100]);
    const approachScale = useTransform(progress, approachRange, [0, 1]);
    const returnScale = useTransform(progress, [0, 20], [0, 1]);
    const lateResultScale = useTransform(progress, [0, 20, 80, 100], [0, 1, 1, 0]);
    const outboundDotScale = useTransform(progress, [0, 8], [0, 1]);
    const logoScale = useTransform(() =>
        stage.value === 'returning'
            ? revealOnApproach.value
                ? returnScale.get()
                : lateResultScale.get()
            : revealOnApproach.value
              ? approachScale.get()
              : 0
    );
    const dotScale = useTransform(() => {
        const scale = logoScale.get();
        const position = progress.get();
        if (stage.value === 'returning') {
            return !revealOnApproach.value && position > 80 ? 1 - scale : 0;
        }
        return outboundDotScale.get() * (1 - scale);
    });
    const transition = computed(() => ({
        type: 'tween' as const,
        duration: duration(stage.value === 'returning' ? 1100 : 850) / 1000,
        ease: 'easeInOut' as const,
    }));
    function reachedEnd() {
        if (stage.value === 'returning') emit('complete');
        else if (stage.value === 'outbound') stage.value = 'waiting';
    }
    watch([stage, () => props.activity.phase], ([current, phase]) => {
        if (phase !== 'results') return;
        if (current === 'outbound') {
            const position = Number.parseFloat(offsetDistance.get());
            if (position < 100) {
                approachRange.value = [Math.max(75, position), 100];
                revealOnApproach.value = true;
            }
        } else if (current === 'waiting') {
            stage.value = 'returning';
        }
    });
    onScopeDispose(() => offsetDistance.destroy());
</script>

<template>
    <motion.div
        class="pointer-events-none absolute top-0 left-0 z-20 flex h-5 items-center justify-center"
        :class="activity.sites.length > 1 ? 'w-9' : 'w-5'"
        :style="{ offsetPath: `path('${path}')`, offsetRotate: '0deg', offsetDistance }"
        :animate="{ offsetDistance: stage === 'returning' ? '0%' : '100%' }"
        :transition="transition"
        data-testid="search-route-activity"
        :data-source="activity.source"
        :data-phase="activity.phase"
        aria-hidden="true"
        @animation-complete="reachedEnd"
    >
        <motion.span
            class="absolute size-1 rounded-full bg-muted-foreground/50"
            :style="{ scale: dotScale }"
        />
        <motion.div
            v-if="activity.phase === 'results'"
            class="relative size-full"
            :style="{ scale: logoScale }"
        >
            <span
                v-for="(site, index) in activity.sites"
                :key="site.url"
                class="absolute top-0 left-0 size-5 overflow-hidden rounded-full border border-surface-floating bg-surface-floating"
                :style="{
                    transform: `translateX(${(index * 80) / Math.max(activity.sites.length - 1, 1)}%)`,
                }"
            >
                <SourceFavicon :source="site" :size="18" />
            </span>
        </motion.div>
    </motion.div>
</template>
