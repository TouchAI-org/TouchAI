<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import PasswordInput from '@components/PasswordInput.vue';
    import { Badge } from '@components/ui/badge';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { SegmentedControl } from '@components/ui/segmented-control';
    import { Switch } from '@components/ui/switch';
    import { computed, ref, watch } from 'vue';

    import { t } from '@/i18n';

    interface Props {
        id: string;
        label: string;
        description: string;
        logo: string;
        quota?: string | null;
        enabled: boolean;
        disabled: boolean;
        editable: boolean;
        editing: boolean;
        credential: string;
        endpointValue: string;
        endpointRequired: boolean;
        supportsEndpoint: boolean;
        endpointPlaceholder: string;
        keyPlaceholder: string;
        apiKeyRequired: boolean;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{
        enabled: [value: boolean];
        edit: [];
        cancel: [];
        save: [value: { apiKey: string; endpoint: string }];
    }>();

    const fieldOptions = [
        { value: 'key', label: t('settings.search.provider.keyField') },
        { value: 'endpoint', label: t('settings.search.provider.urlField') },
    ];
    const keyDraft = ref('');
    const endpointDraft = ref('');
    const field = ref<'key' | 'endpoint'>('key');

    watch(
        () => props.editing,
        (editing) => {
            if (!editing) return;
            keyDraft.value = props.credential;
            endpointDraft.value = props.endpointValue;
            field.value = props.endpointRequired ? 'endpoint' : 'key';
        },
        { immediate: true }
    );

    const canSave = computed(() => {
        if (props.endpointRequired) return endpointDraft.value.trim().length > 0;
        if (props.apiKeyRequired && !keyDraft.value.trim()) return false;
        return true;
    });

    function save() {
        if (!canSave.value) return;
        emit('save', {
            apiKey: props.endpointRequired ? '' : keyDraft.value.trim(),
            endpoint: props.supportsEndpoint ? endpointDraft.value.trim() : '',
        });
    }
</script>

<template>
    <article
        data-testid="search-provider-row"
        :data-provider="id"
        class="relative h-26 min-w-0 rounded-card border border-border-subtle bg-surface-floating"
        :class="editing ? 'z-30' : ''"
    >
        <Transition name="provider-slide">
            <div
                v-if="editing"
                key="editor"
                data-testid="search-provider-editor"
                class="absolute inset-0 z-20 flex flex-col rounded-card border border-border-subtle bg-surface-floating p-3.5 shadow-lg"
            >
                <div class="flex min-w-0 items-center gap-2">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        data-testid="search-provider-editor-back"
                        :aria-label="t('settings.search.editor.back')"
                        @click="emit('cancel')"
                    >
                        <AppIcon name="arrow-left" class="size-4" />
                    </Button>
                    <span
                        v-if="logo"
                        class="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border-subtle bg-surface-sunken p-0.5"
                    >
                        <img :src="logo" alt="" class="size-full rounded-lg object-contain" />
                    </span>
                    <h3 class="min-w-0 flex-1 truncate text-compact font-medium text-settings-text">
                        {{ label }}
                    </h3>
                    <SegmentedControl
                        v-if="supportsEndpoint && !endpointRequired"
                        v-model="field"
                        data-testid="search-provider-credential-tabs"
                        :options="fieldOptions"
                        :aria-label="t('settings.search.provider.credentialType')"
                    />
                </div>
                <div class="mt-2 flex min-w-0 items-center gap-2">
                    <div class="min-w-0 flex-1">
                        <Input
                            v-if="field === 'endpoint'"
                            v-model="endpointDraft"
                            variant="filled"
                            type="url"
                            :data-testid="`search-${id}-base-url-input`"
                            :placeholder="endpointPlaceholder"
                            spellcheck="false"
                        />
                        <PasswordInput
                            v-else
                            v-model="keyDraft"
                            :input-test-id="`search-${id}-api-key-input`"
                            :placeholder="keyPlaceholder"
                            class="!mt-0"
                        />
                    </div>
                    <Button
                        variant="strong"
                        class="h-9 shrink-0"
                        data-testid="search-provider-editor-save"
                        :disabled="!canSave"
                        @click="save"
                    >
                        {{ t('settings.search.editor.save') }}
                    </Button>
                </div>
            </div>
            <div v-else key="display" class="flex h-full min-w-0 items-center gap-3 px-3.5">
                <span
                    class="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border-subtle bg-surface-sunken p-1"
                >
                    <img :src="logo" alt="" class="size-full rounded-xl object-contain" />
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
                        class="m-0 mt-1 line-clamp-2 text-caption leading-4 whitespace-pre-line text-text-secondary"
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
                    <span v-else class="size-7 shrink-0" aria-hidden="true" />
                </div>
            </div>
        </Transition>
    </article>
</template>

<style scoped>
    .provider-slide-enter-active,
    .provider-slide-leave-active {
        transition:
            transform 180ms var(--ease-smooth-out),
            opacity 180ms var(--ease-smooth-out);
    }

    .provider-slide-enter-from {
        transform: translateX(24px);
        opacity: 0;
    }

    .provider-slide-leave-to {
        transform: translateX(-24px);
        opacity: 0;
    }
</style>
