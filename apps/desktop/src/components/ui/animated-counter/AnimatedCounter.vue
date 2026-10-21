<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    /**
     * 会数上去的数字。
     *
     * 参考 uiarc 的 animated-counter：数值变化时不是整块跳变，而是
     * 用弹簧从旧值推到新值，读起来像仪表在走字。
     *
     * 这里没有采用参考实现的「逐位滚轮」。滚轮在数值中途会同时露出
     * 相邻两位，静态截图或慢速刷新时看起来像重影；而用量卡片的价值在于
     * 随时都能一眼读准，动画只是陪衬。所以保留弹簧计数，去掉滚轮。
     */
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    interface Props {
        value: number;
        prefix?: string;
        suffix?: string;
        /** 固定小数位 */
        decimals?: number;
        /** 首次进入视口时从 0 数上来 */
        animateOnView?: boolean;
        /** 数字格式化区域 */
        locale?: string;
        /** 直接给一个格式化好的文本，此时不做数字动画 */
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

    // ===== 弹簧 =====

    const STIFFNESS = 210;
    const DAMPING = 28;
    const REST = 0.0005;

    const display = ref(0);
    let raf = 0;
    let velocity = 0;

    function step(): void {
        const delta = props.value - display.value;
        // 半隐式欧拉：先更新速度再更新位置，比显式欧拉稳定
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

    // ===== 进入视口时从 0 数上来 =====

    const root = ref<HTMLElement | null>(null);
    let observer: IntersectionObserver | null = null;
    const armed = ref(props.animateOnView);

    onMounted(() => {
        // jsdom 没有 matchMedia，测试环境里当作没有开启减弱动效
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

    // ===== 渲染 =====

    const plain = computed(() => props.text !== undefined);

    /** 动画中的数值：按同样的规则格式化，位数变化时不会跳动 */
    const shown = computed(() =>
        new Intl.NumberFormat(props.locale, {
            minimumFractionDigits: props.decimals,
            maximumFractionDigits: props.decimals,
        }).format(armed.value ? 0 : display.value)
    );

    /** 读屏用：直接读最终值，不读动画中间态 */
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
