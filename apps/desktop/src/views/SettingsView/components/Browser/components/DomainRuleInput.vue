<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Input } from '@components/ui/input';
    import { onMounted, ref } from 'vue';

    import { t } from '@/i18n';

    const props = defineProps<{
        disabled: boolean;
        label: string;
        placeholder: string;
    }>();
    const model = defineModel<string>({ required: true });
    const emit = defineEmits<{
        submit: [];
        cancel: [];
    }>();
    // ui/Input 通过 defineExpose 暴露 focus()，不是原生 HTMLInputElement
    const inputRef = ref<{ focus: () => void } | null>(null);

    function handleBlur() {
        if (!model.value.trim()) {
            emit('cancel');
        }
    }

    function handleSubmit(event: KeyboardEvent) {
        if (event.isComposing || props.disabled) return;
        event.preventDefault();
        emit('submit');
    }

    onMounted(() => inputRef.value?.focus());
</script>

<template>
    <div class="flex gap-2">
        <Input
            ref="inputRef"
            v-model="model"
            variant="filled"
            :disabled="disabled"
            :aria-label="label"
            :placeholder="placeholder"
            type="text"
            spellcheck="false"
            class="flex-1 px-4 py-2.5 font-mono disabled:bg-neutral-50"
            @blur="handleBlur"
            @keydown.enter="handleSubmit"
        />
        <button
            type="button"
            class="text-neutral-400 transition-colors hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="disabled"
            :title="t('common.cancel')"
            :aria-label="t('common.cancel')"
            @click="emit('cancel')"
        >
            <AppIcon name="x" class="h-5 w-5" />
        </button>
    </div>
</template>
