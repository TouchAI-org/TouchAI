<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Badge } from '@components/ui/badge';
    import { Button } from '@components/ui/button';
    import { Switch } from '@components/ui/switch';

    import { t } from '@/i18n';

    defineProps<{
        id: string;
        label: string;
        description: string;
        logo: string;
        quota?: string | null;
        enabled: boolean;
        disabled: boolean;
        editable: boolean;
    }>();

    const emit = defineEmits<{
        enabled: [value: boolean];
        edit: [];
    }>();
</script>

<template>
    <article
        data-testid="search-provider-row"
        :data-provider="id"
        class="flex h-18 min-w-0 items-center gap-3 rounded-card border border-border-subtle bg-surface-floating px-3.5"
    >
        <span class="flex size-9 shrink-0 items-center justify-center overflow-hidden">
            <img :src="logo" alt="" class="size-full object-contain" />
        </span>
        <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-1.5">
                <span
                    class="min-w-0 truncate text-compact leading-5 font-medium text-settings-text"
                    :title="label"
                >
                    {{ label }}
                </span>
                <Badge
                    v-if="quota"
                    variant="source"
                    :data-testid="`search-provider-quota-${id}`"
                    class="shrink-0"
                >
                    {{ quota }}
                </Badge>
            </div>
            <p
                class="m-0 mt-0.5 truncate text-caption leading-4 text-text-secondary"
                :title="description"
            >
                {{ description }}
            </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
            <Switch
                :data-testid="`search-provider-toggle-${id}`"
                :aria-label="label"
                :model-value="enabled"
                :disabled="disabled"
                @update:model-value="emit('enabled', $event)"
            />
            <Button
                v-if="editable"
                variant="ghost"
                size="icon-sm"
                :data-testid="`search-provider-edit-${id}`"
                :aria-label="t('settings.search.editProvider', { name: label })"
                :disabled="disabled"
                @click="emit('edit')"
            >
                <AppIcon name="edit" class="size-4" />
            </Button>
        </div>
    </article>
</template>
