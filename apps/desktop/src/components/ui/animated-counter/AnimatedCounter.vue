<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    /**
     * Numerals that count to their value.
     *
     * A changed value is not swapped in one frame: a spring drives it from the
     * old number to the new one, so it reads like a gauge settling.
     *
     * Per-digit wheels are deliberately not used. A wheel shows two adjacent
     * digits mid-turn, which looks like double exposure in a still screenshot
     * or on a slow repaint, and a usage card has to be readable at a glance at
     * any moment.
     */
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    interface Props {
        value: number;
        prefix?: string;
        suffix?: string;
        /** Fixed decimal places. */
        decimals?: number;
        /** Count up from zero the first time it enters the viewport. */
        animateOnView?: boolean;
        /** Number locale. */
        locale?: string;
        /** Pre-formatted text; when set no counting animation runs. */
        text?: string;
    }

    const props = withDefaults(defineProps<Props>(), {
        prefix: '',
        suffix: '',
        decimals: 0,
        animateOnView: false,
        locale: 'zh-CN',
        text: undefined,
    });

    defineOptions({ name: 'AnimatedCounter' });

    // ===== Spring =====

    const STIFFNESS = 210;
    const DAMPING = 28;
    const REST = 0.0005;

    const display = ref(0);
    let raf = 0;
    let velocity = 0;

    function step(): void {
        const delta = props.value - display.value;
        // Semi-implicit Euler: update velocity before position, which is more stable than explicit.
        velocity += (STIFFNESS * delta - DAMPING * velocity) * (1 / 60);
        display.value += velocity * (1 / 60);

        if (Math.abs(delta) < REST && Math.abs(velocity) < REST) {
            display.value = props.value;
            velocity = 0;
            raf = 0;
            return;
        }
        raf = requestAnimationFrame(step);
    }

    function kick(): void {
        if (raf) return;
        raf = requestAnimationFrame(step);
    }

    const reducedMotion = ref(false);

    watch(
        () => props.value,
        (next, previous) => {
            if (reducedMotion.value || previous === undefined) {
                display.value = next;
                return;
            }
            kick();
        },
        { immediate: true }
    );

    // ===== Count up on entering the viewport =====

    const root = ref<HTMLElement | null>(null);
    let observer: IntersectionObserver | null = null;
    const armed = ref(props.animateOnView);

    onMounted(() => {
        // jsdom has no matchMedia; under test treat reduced motion as off.
        reducedMotion.value =
            typeof window.matchMedia === 'function'
                ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
                : false;

        if (!props.animateOnView) return;
        const el = root.value;
        if (!el || typeof IntersectionObserver === 'undefined') {
            armed.value = false;
            return;
        }

        observer = new IntersectionObserver(
            (entries) => {
                if (!entries[0]?.isIntersecting) return;
                observer?.disconnect();
                observer = null;
                armed.value = false;
                display.value = 0;
                kick();
            },
            { threshold: 0.5 }
        );
        observer.observe(el);
    });

    onBeforeUnmount(() => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        observer?.disconnect();
        observer = null;
    });

    // ===== Render =====

    const plain = computed(() => props.text !== undefined);

    /** In-flight value formatted by the same rules, so digit count changes do not jump. */
    const shown = computed(() =>
        new Intl.NumberFormat(props.locale, {
            minimumFractionDigits: props.decimals,
            maximumFractionDigits: props.decimals,
        }).format(armed.value ? 0 : display.value)
    );

    /** Screen readers get the final value, never an intermediate frame. */
    const spoken = computed(() =>
        plain.value
            ? (props.text ?? '')
            : `${props.prefix}${new Intl.NumberFormat(props.locale, {
                  minimumFractionDigits: props.decimals,
                  maximumFractionDigits: props.decimals,
              }).format(props.value)}${props.suffix}`
    );
</script>

<template>
    <span ref="root" class="inline-flex items-baseline tabular-nums" :data-value="spoken">
        <span class="sr-only">{{ spoken }}</span>

        <span v-if="plain" aria-hidden="true">{{ text }}</span>
        <template v-else>
            <span aria-hidden="true">
                <span v-if="prefix">{{ prefix }}</span>
                {{ shown }}
                <span v-if="suffix">{{ suffix }}</span>
            </span>
        </template>
    </span>
</template>
