<template>
    <button
        type="button"
        data-slot="result-item"
        :disabled="disabled"
        :title="label"
        class="flex min-w-0 shrink-0 cursor-pointer items-center overflow-hidden rounded-md font-serif outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50"
        :class="[
            layout === 'grid'
                ? 'h-22 w-full flex-col justify-center p-1'
                : compact
                  ? 'h-8 w-full gap-2 px-2'
                  : 'h-12 w-full gap-3 px-3',
            highlighted ? 'bg-search-selected' : 'hover:bg-search-hover',
        ]"
        @click="emit('click')"
        @contextmenu.prevent="emit('contextmenu', $event)"
        @mouseenter="hovered = true"
        @mouseleave="hovered = false"
    >
        <span
            v-if="showIcon"
            data-slot="result-item-icon"
            aria-hidden="true"
            class="flex shrink-0 items-center justify-center"
            :class="[compact ? 'h-5 w-5' : 'h-8 w-8', layout === 'grid' ? 'my-1' : '']"
        >
            <slot name="leading">
                <img
                    v-if="iconSrc"
                    :src="iconSrc"
                    :alt="label"
                    :loading="iconFit === 'cover' ? 'lazy' : 'eager'"
                    :decoding="iconFit === 'cover' ? 'async' : 'auto'"
                    class="rounded-md"
                    :class="[
                        compact ? 'h-5 w-5' : 'h-8 w-8',
                        iconFit === 'cover' ? 'object-cover' : 'object-contain',
                    ]"
                />
                <span
                    v-else
                    class="rounded-md border border-search-border bg-search-hover"
                    :class="compact ? 'h-5 w-5' : 'h-8 w-8'"
                ></span>
            </slot>
        </span>
        <span
            class="min-w-0"
            :class="
                layout === 'grid'
                    ? 'w-full px-0.5'
                    : compact
                      ? 'flex flex-1 items-center gap-2 overflow-hidden text-left'
                      : 'flex-1 overflow-hidden text-left'
            "
            data-no-i18n="true"
            translate="no"
        >
            <span
                data-slot="result-item-label"
                class="text-search-text"
                :class="
                    layout === 'grid'
                        ? 'line-clamp-2 h-10 text-center text-xs leading-5 break-words'
                        : compact
                          ? 'block max-w-1/2 min-w-0 shrink-0 truncate text-xs leading-5'
                          : 'block truncate text-sm leading-5'
                "
            >
                <template v-if="segments?.length">
                    <span
                        v-for="(segment, index) in segments"
                        :key="index"
                        :class="segment.matched ? 'font-semibold text-search-match' : ''"
                    >
                        {{ segment.text }}
                    </span>
                </template>
                <template v-else>{{ label }}</template>
            </span>
            <span
                v-if="description && layout === 'list'"
                class="block min-w-0 overflow-hidden"
                :class="compact ? 'flex-1' : ''"
            >
                <span
                    ref="descriptionElement"
                    data-slot="result-item-description"
                    class="block truncate text-xs leading-4 text-search-muted"
                >
                    {{ description }}
                </span>
            </span>
        </span>
        <span v-if="$slots.trailing" class="flex shrink-0 items-center">
            <slot name="trailing" />
        </span>
    </button>
</template>

<script setup lang="ts">
    import { computed, onBeforeUnmount, ref, watch } from 'vue';

    import { motionSeconds, useMotion } from '@/composables/useMotion';
    import type { NameSegment } from '@/utils/searchHighlight';

    defineOptions({ name: 'UiResultItem' });

    const props = withDefaults(
        defineProps<{
            label: string;
            layout?: 'list' | 'grid';
            iconSrc?: string;
            iconFit?: 'contain' | 'cover';
            description?: string;
            segments?: NameSegment[];
            highlighted?: boolean;
            disabled?: boolean;
            compact?: boolean;
            showIcon?: boolean;
        }>(),
        {
            description: '',
            layout: 'list',
            iconSrc: undefined,
            iconFit: 'contain',
            segments: undefined,
            highlighted: false,
            disabled: false,
            compact: false,
            showIcon: true,
        }
    );

    const emit = defineEmits<{
        click: [];
        contextmenu: [event: MouseEvent];
    }>();

    const descriptionElement = ref<HTMLElement | null>(null);
    const hovered = ref(false);
    const { reducedMotion, duration } = useMotion();
    const revealActive = computed(
        () => (hovered.value || props.highlighted) && !props.disabled && !reducedMotion.value
    );
    let descriptionAnimation: Animation | undefined;

    function stopDescriptionReveal() {
        descriptionAnimation?.cancel();
        descriptionAnimation = undefined;
        descriptionElement.value?.style.removeProperty('overflow');
    }

    function startDescriptionReveal() {
        stopDescriptionReveal();
        const element = descriptionElement.value;
        if (
            props.disabled ||
            reducedMotion.value ||
            props.layout !== 'list' ||
            !element ||
            typeof element.animate !== 'function'
        )
            return;

        const overflow = element.scrollWidth - element.clientWidth;
        if (element.clientWidth <= 0 || overflow <= 0) return;

        const css = getComputedStyle(document.documentElement);
        const pixelDuration =
            motionSeconds(css.getPropertyValue('--motion-description-pixel-duration')) * 1000;
        const revealDuration = duration(overflow * pixelDuration);
        if (revealDuration <= 0) return;

        // The text's existing parent clips the reveal without resizing or duplicating the line.
        element.style.overflow = 'visible';
        descriptionAnimation = element.animate(
            [{ transform: 'translateX(0)' }, { transform: `translateX(${-overflow}px)` }],
            {
                delay: duration(
                    motionSeconds(css.getPropertyValue('--motion-description-delay')) * 1000
                ),
                duration: revealDuration,
                easing: css.getPropertyValue('--ease-linear').trim() || 'linear',
                fill: 'forwards',
            }
        );
    }

    watch(
        [revealActive, descriptionElement],
        ([active]) => (active ? startDescriptionReveal() : stopDescriptionReveal()),
        { flush: 'post' }
    );
    watch(
        [
            () => props.description,
            () => props.layout,
            () => props.compact,
            () => props.disabled,
            reducedMotion,
        ],
        stopDescriptionReveal,
        { flush: 'sync' }
    );
    onBeforeUnmount(stopDescriptionReveal);
</script>
