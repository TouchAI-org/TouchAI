<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import CustomSelect from '@components/CustomSelect.vue';
    import { useMotion } from '@composables/useMotion';
    import {
        resolveSearchSourceProviders,
        SEARCH_SOURCES,
        type SearchProviderId,
        type SearchSettingsConfig,
        type SearchSource,
    } from '@services/SettingsService/domain';
    import { AnimatePresence, motion } from 'motion-v';
    import { computed, onMounted, onScopeDispose, ref } from 'vue';

    import { type MessageKey, t } from '@/i18n';

    import { useSearchRoutingActivity } from '../useSearchRoutingActivity';
    import SearchRouteActivity from './SearchRouteActivity.vue';

    const props = defineProps<{
        settings: SearchSettingsConfig;
        options: Array<{ value: SearchProviderId; label: string; iconSrc?: string }>;
        disabled: boolean;
    }>();
    const emit = defineEmits<{ select: [source: SearchSource, provider: SearchProviderId] }>();
    const { transitions, reducedMotion, windowVisible } = useMotion();
    const { activities, remove } = useSearchRoutingActivity(
        computed(() => !props.disabled && !reducedMotion.value && windowVisible.value)
    );
    const surface = ref<HTMLElement | null>(null);
    const size = ref({ width: 1000, height: 336 });
    let observer: ResizeObserver | undefined;
    onMounted(() => {
        if (!surface.value) return;
        const measure = () => {
            const rect = surface.value?.getBoundingClientRect();
            if (rect?.width && rect.height) size.value = { width: rect.width, height: rect.height };
        };
        measure();
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(measure);
            observer.observe(surface.value);
        }
    });
    onScopeDispose(() => observer?.disconnect());
    const sourceMessages: Record<SearchSource, MessageKey> = {
        general: 'settings.search.source.general',
        news: 'settings.search.source.news',
        community: 'settings.search.source.community',
        academic: 'settings.search.source.academic',
        code: 'settings.search.source.code',
        official: 'settings.search.source.official',
        realtime: 'settings.search.source.realtime',
    };

    const branches = computed(() =>
        SEARCH_SOURCES.map((source, index) => {
            const x = ((index + 0.5) / SEARCH_SOURCES.length) * 1000;
            const provider = resolveSearchSourceProviders(source, props.settings)[0];
            const option = props.options.find((entry) => entry.value === provider);
            const automatic = resolveSearchSourceProviders(source, {
                ...props.settings,
                sourceRoutes: { ...props.settings.sourceRoutes, [source]: 'auto' },
            })[0];
            const recommended = props.options.find((entry) => entry.value === automatic);
            return {
                source,
                provider,
                label: t(sourceMessages[source]),
                providerLabel: option?.label ?? t('settings.search.route.unavailable'),
                logo: option?.iconSrc,
                left: `${x / 10}%`,
                path: `M500 56 C500 125 ${x} 150 ${x} 240`,
                motionPath: `M${size.value.width / 2} ${size.value.height / 6} C${size.value.width / 2} ${(size.value.height * 125) / 336} ${(x * size.value.width) / 1000} ${(size.value.height * 150) / 336} ${(x * size.value.width) / 1000} ${(size.value.height * 240) / 336}`,
                options: props.options.map((entry) =>
                    entry.value === 'auto'
                        ? {
                              ...entry,
                              label: recommended
                                  ? t('settings.search.route.auto', { name: recommended.label })
                                  : t('settings.search.route.unavailable'),
                              iconSrc: recommended?.iconSrc,
                          }
                        : entry
                ),
            };
        })
    );
</script>

<template>
    <div
        ref="surface"
        class="relative h-84 overflow-hidden rounded-card border border-border-subtle bg-surface-floating"
    >
        <div
            class="absolute top-5 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border-subtle bg-surface-floating"
        >
            <AppIcon name="search" class="size-4 text-text-tertiary" />
        </div>
        <svg
            class="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 1000 336"
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            <path
                v-for="branch in branches"
                :key="branch.source"
                :d="branch.path"
                fill="none"
                class="stroke-border-subtle"
                stroke-width="1"
                vector-effect="non-scaling-stroke"
            />
        </svg>
        <SearchRouteActivity
            v-for="activity in activities"
            :key="activity.id"
            :activity="activity"
            :path="branches.find((branch) => branch.source === activity.source)!.motionPath"
            @complete="remove(activity.id)"
        />
        <div
            v-for="branch in branches"
            :key="branch.source"
            class="absolute top-60 flex w-1/7 -translate-x-1/2 flex-col items-center gap-1.5 px-0.5"
            :style="{ left: branch.left }"
        >
            <span
                class="w-full truncate text-center text-compact font-bold text-settings-text"
                :title="branch.label"
            >
                {{ branch.label }}
            </span>
            <CustomSelect
                :model-value="settings.sourceRoutes[branch.source]"
                :options="branch.options"
                trigger-variant="icon"
                :data-testid="`search-source-route-${branch.source}`"
                :trigger-test-id="`search-source-route-${branch.source}`"
                :content-test-id="`search-source-menu-${branch.source}`"
                :aria-label="`${branch.label} · ${branch.providerLabel}`"
                :title="branch.providerLabel"
                :disabled="disabled"
                @update:model-value="emit('select', branch.source, $event)"
            >
                <template #trigger>
                    <span
                        class="relative flex size-full items-center justify-center overflow-hidden rounded-full bg-surface-floating p-1"
                    >
                        <AnimatePresence :initial="false" mode="popLayout">
                            <motion.img
                                v-if="branch.logo"
                                :key="branch.provider"
                                :src="branch.logo"
                                alt=""
                                class="size-full rounded-full object-contain"
                                :initial="{ opacity: 0, scale: reducedMotion ? 1 : 0.85 }"
                                :animate="{ opacity: 1, scale: 1 }"
                                :exit="{ opacity: 0, scale: reducedMotion ? 1 : 0.85 }"
                                :transition="transitions.fast"
                            />
                            <AppIcon v-else name="search" class="size-4 text-text-tertiary" />
                        </AnimatePresence>
                    </span>
                </template>
            </CustomSelect>
        </div>
    </div>
</template>
