<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts" generic="T extends string">
    import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

    export interface SectionTabItem<TValue extends string = string> {
        value: TValue;
        label: string;
    }

    interface Props<TValue extends string> {
        modelValue: TValue;
        tabs: SectionTabItem<TValue>[];
    }

    const props = defineProps<Props<T>>();

    const emit = defineEmits<{
        'update:modelValue': [value: T];
    }>();

    const tabListRef = ref<HTMLElement | null>(null);
    const indicatorStyle = ref({ transform: 'translateX(0)', width: '0px' });
    const indicatorVisible = ref(false);
    const indicatorAnimated = ref(false);
    const tabRefs = new Map<T, HTMLButtonElement>();
    let resizeObserver: ResizeObserver | null = null;

    function setTabRef(value: T, element: Element | null) {
        const previous = tabRefs.get(value);
        if (previous === element) return;
        if (previous) resizeObserver?.unobserve(previous);
        if (element instanceof HTMLButtonElement) {
            tabRefs.set(value, element);
            resizeObserver?.observe(element);
        } else {
            tabRefs.delete(value);
        }
    }

    function measureIndicator(animate: boolean) {
        const button = tabRefs.get(props.modelValue);
        if (!button) {
            indicatorVisible.value = false;
            return;
        }

        indicatorAnimated.value = animate;
        indicatorStyle.value = {
            transform: `translateX(${button.offsetLeft}px)`,
            width: `${button.offsetWidth}px`,
        };
        indicatorVisible.value = true;
    }

    function handleSelect(value: T) {
        if (value === props.modelValue) return;
        emit('update:modelValue', value);
    }

    onMounted(() => {
        measureIndicator(false);
        resizeObserver =
            typeof ResizeObserver !== 'undefined'
                ? new ResizeObserver(() => {
                      measureIndicator(false);
                  })
                : null;
        if (resizeObserver) {
            if (tabListRef.value) resizeObserver.observe(tabListRef.value);
            tabRefs.forEach((button) => resizeObserver?.observe(button));
        }
    });

    watch(
        () => props.modelValue,
        () => measureIndicator(true),
        { flush: 'post' }
    );
    watch(
        () => props.tabs,
        () => measureIndicator(false),
        { deep: true, flush: 'post' }
    );

    onBeforeUnmount(() => {
        resizeObserver?.disconnect();
        resizeObserver = null;
        tabRefs.clear();
    });
</script>

<template>
    <div
        class="border-b border-neutral-200/80 bg-white/80 px-8"
        style="padding-bottom: 1px; padding-top: 1px"
    >
        <div ref="tabListRef" class="relative flex gap-6">
            <button
                v-for="tab in tabs"
                :key="tab.value"
                :ref="(element) => setTabRef(tab.value, element as Element | null)"
                type="button"
                :aria-current="modelValue === tab.value ? 'page' : undefined"
                :class="[
                    'border-b-2 border-transparent px-1 py-4 text-sm font-medium transition-colors duration-(--duration-quick)',
                    modelValue === tab.value
                        ? 'text-neutral-950'
                        : 'text-neutral-500 hover:text-neutral-800',
                ]"
                @click="handleSelect(tab.value)"
            >
                {{ tab.label }}
            </button>
            <span
                v-if="indicatorVisible"
                class="t-tabs-indicator"
                :data-animate="indicatorAnimated"
                :style="indicatorStyle"
                aria-hidden="true"
            />
        </div>
    </div>
</template>
