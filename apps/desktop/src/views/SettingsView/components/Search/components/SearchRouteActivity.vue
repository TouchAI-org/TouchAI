<script setup lang="ts">
    import { useMotion } from '@composables/useMotion';
    import type { WebSearchActivityEvent } from '@services/EventService/types';
    import { motion } from 'motion-v';
    import { computed, ref, watch } from 'vue';

    import SourceFavicon from '@/views/SearchView/components/WebSearch/SourceFavicon.vue';

    const props = defineProps<{ activity: WebSearchActivityEvent; path: string }>();
    const emit = defineEmits<{ complete: [] }>();
    const { duration } = useMotion();
    const stage = ref<'outbound' | 'waiting' | 'returning'>(
        props.activity.phase === 'results' ? 'returning' : 'outbound'
    );
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
        if (current === 'waiting' && phase === 'results') stage.value = 'returning';
    });
</script>

<template>
    <motion.div
        class="pointer-events-none absolute top-0 left-0 z-20 flex items-center justify-center"
        :style="{ offsetPath: `path('${path}')`, offsetRotate: '0deg' }"
        :initial="{ offsetDistance: activity.phase === 'results' ? '100%' : '0%' }"
        :animate="{ offsetDistance: stage === 'returning' ? '0%' : '100%' }"
        :transition="transition"
        data-testid="search-route-activity"
        :data-source="activity.source"
        :data-phase="activity.phase"
        aria-hidden="true"
        @animation-complete="reachedEnd"
    >
        <div v-if="stage === 'returning'" class="flex items-center -space-x-2">
            <span
                v-for="site in activity.sites"
                :key="site.url"
                class="rounded-full border-2 border-surface-floating bg-surface-floating"
            >
                <SourceFavicon :source="site" :size="20" />
            </span>
        </div>
        <span v-else class="size-2 rounded-full bg-text-tertiary" />
    </motion.div>
</template>
