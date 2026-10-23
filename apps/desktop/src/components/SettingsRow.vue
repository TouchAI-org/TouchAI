<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'SettingsRow',
        /*
         * 必须关闭属性自动继承：外层 div 的 class 要由 cn() 合并，
         * 而 data-* / v-for / v-if 这类属性要原样落到同一个根元素上。
         * 若开启自动继承，class 会与内部的 cn() 结果重复。
         */
        inheritAttrs: false,
    });

    import type { HTMLAttributes } from 'vue';
    import { computed, useAttrs } from 'vue';

    import { cn } from '@/lib/utils';

    /*
     * 设置页的「标签 + 描述 + 控件」三段式行。
     *
     * 项目里这段结构在 6 个文件中被手写了 29 遍，网格断点、内边距、
     * 标签字号与描述颜色完全一致，只有几件事不同：
     *   1. 控件列宽度（auto / 180px / 220px / 320px / 360px）
     *   2. 描述是否出现
     *   3. 标签用 <div> 还是 <label>
     *   4. 个别行的控件容器需要额外 class（如 ml-auto w-[180px]）
     *
     * 宽度用枚举而不是裸字符串，避免调用点再写出新的档位。
     */
    type ControlWidth = 'auto' | '180' | '220' | '320' | '360';

    interface Props {
        /** 主标签文本。也可用 #label 插槽替代 */
        label?: string;
        /** 可选的说明文字。不传时整行只渲染标签 */
        description?: string;
        /** 控件列宽度档位，对应原实现里 sm:grid-cols-[minmax(0,1fr)_Npx] */
        controlWidth?: ControlWidth;
        /**
         * 标签元素类型。原实现中多数用 <div>，部分用 <label>（配合表单控件
         * 的 for 关联）或作为语义标签。默认 div，与多数调用点一致。
         */
        labelAs?: 'div' | 'label' | 'span';
        /** 标签的 for 属性，仅 labelAs="label" 时有意义 */
        labelFor?: string;
        /** 附加到标签元素上的 class */
        labelClass?: HTMLAttributes['class'];
        /** 附加到标签元素上的其它属性（data-testid 等） */
        labelAttrs?: Record<string, unknown>;
        /** 附加到描述元素上的 class */
        descriptionClass?: HTMLAttributes['class'];
        /** 附加到控件容器上的 class */
        controlClass?: HTMLAttributes['class'];
        /** 附加到控件容器上的其它属性（data-testid 等） */
        controlAttrs?: Record<string, unknown>;
        class?: HTMLAttributes['class'];
    }

    const props = withDefaults(defineProps<Props>(), {
        label: '',
        description: undefined,
        controlWidth: '320',
        labelAs: 'div',
        labelFor: undefined,
        labelClass: '',
        labelAttrs: undefined,
        descriptionClass: '',
        controlClass: '',
        controlAttrs: undefined,
        class: '',
    });

    const attrs = useAttrs();

    const WIDTH_CLASS: Record<ControlWidth, string> = {
        auto: 'sm:grid-cols-[minmax(0,1fr)_auto]',
        '180': 'sm:grid-cols-[minmax(0,1fr)_180px]',
        '220': 'sm:grid-cols-[minmax(0,1fr)_220px]',
        '320': 'sm:grid-cols-[minmax(0,1fr)_320px]',
        '360': 'sm:grid-cols-[minmax(0,1fr)_360px]',
    };

    const rowClass = computed(() =>
        cn(
            'grid min-w-0 gap-4 px-5 py-4 sm:items-center',
            WIDTH_CLASS[props.controlWidth],
            props.class
        )
    );

    /** 除 class 之外的所有属性都透传到根元素（data-settings-search-target 等） */
    const forwardedAttrs = computed(() => {
        const rest = { ...(attrs as Record<string, unknown>) };
        delete rest.class;
        return rest;
    });

    const labelClasses = computed(() =>
        cn('text-compact leading-6 font-normal text-neutral-900', props.labelClass)
    );
</script>

<template>
    <div v-bind="forwardedAttrs" :class="rowClass">
        <div>
            <component
                :is="labelAs"
                v-bind="labelAttrs"
                :for="labelAs === 'label' ? labelFor : undefined"
                :class="labelClasses"
            >
                <slot name="label">{{ label }}</slot>
            </component>
            <div
                v-if="description"
                :class="cn('mt-1 text-xs text-neutral-500', props.descriptionClass)"
            >
                {{ description }}
            </div>
            <slot name="description" />
        </div>
        <div v-bind="controlAttrs" :class="cn('min-w-0', props.controlClass)">
            <slot />
        </div>
    </div>
</template>
