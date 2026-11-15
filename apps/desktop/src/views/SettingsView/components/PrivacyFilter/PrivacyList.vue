<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { ref } from 'vue';

    import { t } from '@/i18n';

    const props = defineProps<{
        label: string;
        placeholder: string;
        items: string[];
        testId: string;
        disabled: boolean;
    }>();
    const emit = defineEmits<{
        add: [value: string];
        remove: [value: string];
    }>();
    const draft = ref('');

    function submit() {
        if (props.disabled || !draft.value.trim() || props.items.length >= 500) return;
        emit('add', draft.value.trim());
        draft.value = '';
    }
</script>

<template>
    <div class="space-y-2">
        <form class="flex min-w-0 items-center gap-2" @submit.prevent="submit">
            <Input
                v-model="draft"
                variant="filled"
                maxlength="256"
                autocomplete="off"
                spellcheck="false"
                class="min-w-0 flex-1"
                :placeholder="placeholder"
                :aria-label="label"
                :data-testid="`privacy-filter-${testId}-input`"
                :disabled="disabled"
            />
            <Button
                variant="ghost-neutral"
                class="shrink-0"
                type="submit"
                :aria-label="t('settings.privacyFilter.addItem', { name: label })"
                :disabled="disabled || !draft.trim() || items.length >= 500"
                :data-testid="`privacy-filter-${testId}-add`"
            >
                <AppIcon name="plus" class="h-4 w-4" />
            </Button>
        </form>
        <ul v-if="items.length" class="space-y-2">
            <li v-for="item in items" :key="item" class="flex min-w-0 items-center gap-2">
                <Input
                    variant="filled"
                    :model-value="item"
                    readonly
                    spellcheck="false"
                    class="min-w-0 flex-1"
                    :aria-label="label"
                    :data-testid="`privacy-filter-${testId}-item`"
                    :disabled="disabled"
                />
                <Button
                    variant="ghost-neutral"
                    type="button"
                    class="shrink-0"
                    :aria-label="t('settings.privacyFilter.removeItem', { value: item })"
                    :data-testid="`privacy-filter-${testId}-remove`"
                    :disabled="disabled"
                    @click="emit('remove', item)"
                >
                    <AppIcon name="x" class="h-4 w-4" />
                </Button>
            </li>
        </ul>
    </div>
</template>
