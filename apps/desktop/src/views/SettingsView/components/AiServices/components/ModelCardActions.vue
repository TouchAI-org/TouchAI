<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Button } from '@components/ui/button';

    import { t } from '@/i18n';

    defineProps<{
        isDefault: boolean;
    }>();

    const emit = defineEmits<{
        'set-default': [];
        edit: [];
        delete: [];
    }>();
</script>

<template>
    <div class="flex shrink-0 items-center gap-1">
        <Button
            v-if="!isDefault"
            variant="outline-neutral"
            class="pointer-events-none mr-1 inline-flex h-7 items-center justify-center px-2 py-0 whitespace-nowrap opacity-0 group-hover/model:pointer-events-auto group-hover/model:opacity-100 group-has-[:focus-visible]/model:pointer-events-auto group-has-[:focus-visible]/model:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
            :title="t('settings.ai.setDefaultModel')"
            @click="emit('set-default')"
        >
            {{ t('settings.ai.setDefaultAction') }}
        </Button>
        <Button
            variant="ghost-neutral"
            class="h-7 w-7 rounded-md"
            :title="t('common.edit')"
            :aria-label="t('common.edit')"
            @click="emit('edit')"
        >
            <AppIcon name="edit" class="h-4 w-4" />
        </Button>
        <Button
            variant="ghost-neutral"
            class="h-7 w-7 rounded-md"
            :title="t('common.delete')"
            :aria-label="t('common.delete')"
            @click="emit('delete')"
        >
            <AppIcon name="delete" class="h-4 w-4" />
        </Button>
    </div>
</template>
