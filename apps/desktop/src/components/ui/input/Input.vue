<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiInput',
        // 不把 $attrs 自动继承到根节点，而是显式转发到原生 <input>。
        // 否则 maxlength / aria-* / data-* / spellcheck 等属性会被丢在组件外层，
        // 无法到达真正接收用户输入的元素。
        inheritAttrs: false,
    });

    import { cva, type VariantProps } from 'class-variance-authority';
    import type { HTMLAttributes, InputHTMLAttributes } from 'vue';
    import { computed, ref, useAttrs } from 'vue';

    import { cn } from '@/lib/utils';

    /*
     * 两个 variant 对应项目里原有的两套输入框：
     *
     *   default  ui/Input 既有样式（白底 + 灰边）
     *   filled   原 .settings-input（浅灰底 + 透明边 + focus 变白）
     *
     * filled 的类名从 .settings-input 逐字搬来。注意原类定义在
     * @layer components，优先级低于 utilities，所以调用点的
     * px-4 py-2.5 / py-1.5 能覆盖它。搬进 cva 后两者同层，
     * 覆盖关系改由 twMerge 决定 —— input-migration.test.ts 锁定了
     * 实际出现的每种覆盖组合。
     *
     * 原类里还有一条独立的 box-shadow: none（配合 @apply 使用），
     * 这里用 shadow-none 表达；[box-shadow:none] 保证优先级足够，
     * 与 default variant 的做法保持一致。
     *
     * base 里的 t-control 是上游 motion 体系的类（见 styles/motion.css），
     * 负责过渡时长与缓动，不要用 transition-colors 替代它。
     */
    const inputVariants = cva(
        'focus:border-primary-400 t-control flex h-9 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 shadow-none [box-shadow:none] focus:shadow-none focus:[box-shadow:none] focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400',
        {
            variants: {
                variant: {
                    default: '',
                    filled: 'focus:border-primary-300 rounded-control border-transparent bg-surface-sunken px-3 py-2 text-compact text-neutral-900 hover:bg-surface-active focus:bg-white',
                },
            },
            defaultVariants: {
                variant: 'default',
            },
        }
    );

    type InputVariants = VariantProps<typeof inputVariants>;
    type InputVariant = NonNullable<InputVariants['variant']>;

    interface Props {
        class?: HTMLAttributes['class'];
        modelValue?: string | number | null;
        type?: InputHTMLAttributes['type'];
        placeholder?: string;
        disabled?: boolean;
        id?: string;
        name?: string;
        autocomplete?: string;
        variant?: InputVariant;
    }

    interface Emits {
        (e: 'update:modelValue', value: string): void;
        (e: 'input', event: Event): void;
        (e: 'focus', event: FocusEvent): void;
        (e: 'blur', event: FocusEvent): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        modelValue: '',
        type: 'text',
        class: '',
        placeholder: '',
        id: undefined,
        name: undefined,
        autocomplete: undefined,
        variant: 'default',
    });

    const emit = defineEmits<Emits>();

    const attrs = useAttrs();

    const inputRef = ref<HTMLInputElement | null>(null);

    /*
     * 向父组件暴露原生 input 的方法。
     * 调用点常用 ref="inputRef" 后直接 inputRef.value?.focus()，
     * 若组件不暴露这些方法，那类调用会在运行时报
     * "inputRef.value?.focus is not a function"。
     */
    defineExpose({
        focus: () => inputRef.value?.focus(),
        blur: () => inputRef.value?.blur(),
        select: () => inputRef.value?.select(),
        /** 原生元素本身，供需要读 selectionStart 等属性的调用点使用 */
        el: inputRef,
    });

    const value = computed(() => (props.modelValue == null ? '' : String(props.modelValue)));

    const resolvedClass = computed(() =>
        cn(inputVariants({ variant: props.variant }), props.class)
    );

    const handleInput = (event: Event) => {
        const target = event.target as HTMLInputElement;
        emit('update:modelValue', target.value);
        emit('input', event);
    };
</script>

<template>
    <input
        v-bind="attrs"
        :id="id"
        ref="inputRef"
        :value="value"
        :type="type"
        :placeholder="placeholder"
        :disabled="disabled"
        :name="name"
        :autocomplete="autocomplete"
        :class="resolvedClass"
        @input="handleInput"
        @focus="$emit('focus', $event)"
        @blur="$emit('blur', $event)"
    />
</template>
