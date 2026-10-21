<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiSwitch',
    });

    import { cva, type VariantProps } from 'class-variance-authority';
    import { SwitchRoot, SwitchThumb } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    /*
     * 项目里原有的手写 toggle 有三种尺寸，thumb 各不相同，像素级不等价，
     * 必须分别保留（「统一尺寸」就是视觉变化）：
     *
     *   sm   thumb h-3 w-3（12px），流式定位，位移 translate-x-5 / translate-x-1
     *        （BuiltInToolList / McpServerCard / McpToolList）
     *   md   thumb h-4 w-4（16px），absolute top-0.5 left-0.5，位移 translate-x-4 / 0
     *        （ProviderCard / BashToolConfig）
     *   lg   thumb h-3.5 w-3.5（14px），流式定位，位移 translate-x-[18px] / translate-x-1
     *        （General/index.vue 两处 + UpdateSettingsSection）
     *
     * 另外 BashToolConfig 的开启色是 bg-primary-500 / 关闭色 bg-gray-200，
     * 与其余位置的 bg-primary-700 / bg-neutral-200 不同，用 tone 区分。
     */
    const switchRootVariants = cva('', {
        variants: {
            size: {
                sm: 't-toggle-track relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full',
                md: 't-toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full',
                lg: 't-toggle-track relative inline-flex h-5 w-9 items-center rounded-full',
            },
            tone: {
                default: '',
                subtle: '',
            },
        },
        defaultVariants: {
            size: 'sm',
            tone: 'default',
        },
    });

    const switchThumbVariants = cva('t-toggle-thumb rounded-full bg-white', {
        variants: {
            size: {
                sm: 'inline-block h-3 w-3 transform',
                md: 'absolute top-0.5 left-0.5 h-4 w-4',
                lg: 'inline-block h-3.5 w-3.5 transform',
            },
        },
        defaultVariants: {
            size: 'sm',
        },
    });

    type SwitchVariants = VariantProps<typeof switchRootVariants>;
    type SwitchSize = NonNullable<SwitchVariants['size']>;
    type SwitchTone = NonNullable<SwitchVariants['tone']>;

    interface Props {
        modelValue?: boolean;
        disabled?: boolean;
        size?: SwitchSize;
        tone?: SwitchTone;
        class?: HTMLAttributes['class'];
        /** 额外附加到 track 上的 class（兼容原先用 :class 数组的调用点） */
        trackClass?: HTMLAttributes['class'];
        /** 额外附加到 thumb 上的 class */
        thumbClass?: HTMLAttributes['class'];
        id?: string;
    }

    const props = withDefaults(defineProps<Props>(), {
        modelValue: false,
        disabled: false,
        size: 'sm',
        tone: 'default',
        class: '',
        trackClass: '',
        thumbClass: '',
        id: undefined,
    });

    const emit = defineEmits<{
        'update:modelValue': [value: boolean];
    }>();

    /*
     * 开启/关闭色用 data-state 变体表达。reka-ui 的 SwitchRoot 会输出
     * data-state="checked" | "unchecked"，与原先的条件 class 计算后样式相同。
     */
    const trackClasses = computed(() =>
        cn(
            switchRootVariants({ size: props.size, tone: props.tone }),
            props.tone === 'subtle'
                ? 'data-[state=checked]:bg-primary-500 data-[state=unchecked]:bg-gray-200'
                : 'data-[state=checked]:bg-primary-700 data-[state=unchecked]:bg-neutral-200',
            props.disabled && 'cursor-not-allowed opacity-50',
            props.class,
            props.trackClass
        )
    );

    const thumbClasses = computed(() =>
        cn(
            switchThumbVariants({ size: props.size }),
            props.size === 'sm'
                ? 'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-1'
                : props.size === 'lg'
                  ? 'data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-1'
                  : 'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
            props.thumbClass
        )
    );

    const handleUpdate = (value: boolean) => {
        emit('update:modelValue', value);
    };
</script>

<template>
    <SwitchRoot
        :id="id"
        :model-value="modelValue"
        :disabled="disabled"
        :class="trackClasses"
        @update:model-value="handleUpdate"
    >
        <SwitchThumb :class="thumbClasses" />
    </SwitchRoot>
</template>
