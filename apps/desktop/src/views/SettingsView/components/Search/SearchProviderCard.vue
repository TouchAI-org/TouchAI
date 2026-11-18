<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import PasswordInput from '@components/PasswordInput.vue';
    import { Badge } from '@components/ui/badge';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { ref, watch } from 'vue';

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

    const keyDraft = ref('');
    const endpointDraft = ref('');
    const field = ref<'key' | 'endpoint'>('key');
    const invalid = ref(false);

    watch(
        () => props.editing,
        (editing) => {
            if (!editing) return;
            keyDraft.value = props.credential;
            endpointDraft.value = props.endpointValue;
            field.value = props.endpointRequired ? 'endpoint' : 'key';
            invalid.value = false;
        },
        { immediate: true }
    );

    function save() {
        const apiKey = props.endpointRequired ? '' : keyDraft.value.trim();
        const endpoint = props.endpointRequired
            ? endpointDraft.value.trim()
            : props.supportsEndpoint
              ? endpointDraft.value.trim()
              : '';
        if ((props.apiKeyRequired && !apiKey) || (props.endpointRequired && !endpoint)) {
            invalid.value = true;
            return;
        }
        invalid.value = false;
        emit('save', { apiKey, endpoint });
    }
</script>

<template>
    <article
        data-testid="search-provider-row"
        :data-provider="id"
        class="relative h-18 min-w-0 rounded-card border border-border-subtle bg-surface-floating"
        :class="editing ? 'z-30' : ''"
    >
        <Transition name="provider-slide">
            <div
                v-if="editing"
                key="editor"
                data-testid="search-provider-editor"
                class="absolute inset-x-0 top-0 z-20 grid gap-3 rounded-card border border-border-subtle bg-surface-floating p-4 shadow-lg"
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
                    <img v-if="logo" :src="logo" alt="" class="size-7 shrink-0 object-contain" />
                    <h3 class="min-w-0 flex-1 truncate text-compact font-medium text-settings-text">
                        {{ label }}
                    </h3>
                    <div
                        v-if="supportsEndpoint && !endpointRequired"
                        class="flex shrink-0 items-center rounded-md border border-border-subtle bg-surface-sunken p-0.5"
                    >
                        <button
                            type="button"
                            class="rounded px-1.5 py-0.5 text-2xs"
                            :class="
                                field === 'key'
                                    ? 'bg-white text-text-primary shadow-sm'
                                    : 'text-text-tertiary'
                            "
                            @click="field = 'key'"
                        >
                            {{ t('settings.search.provider.keyField') }}
                        </button>
                        <button
                            type="button"
                            class="rounded px-1.5 py-0.5 text-2xs"
                            :class="
                                field === 'endpoint'
                                    ? 'bg-white text-text-primary shadow-sm'
                                    : 'text-text-tertiary'
                            "
                            @click="field = 'endpoint'"
                        >
                            {{ t('settings.search.provider.urlField') }}
                        </button>
                    </div>
                </div>
                <label class="grid gap-1.5">
                    <span class="text-caption text-text-secondary">
                        {{
                            field === 'endpoint'
                                ? t('settings.search.editor.baseUrl')
                                : t('settings.search.editor.apiKey')
                        }}
                    </span>
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
                </label>
                <p v-if="invalid" class="text-caption text-text-danger">
                    {{ t('settings.search.editor.required') }}
                </p>
                <div class="flex justify-end">
                    <Button
                        variant="strong"
                        data-testid="search-provider-editor-save"
                        @click="save"
                    >
                        {{ t('settings.search.editor.save') }}
                    </Button>
                </div>
            </div>
            <div v-else key="display" class="flex h-full min-w-0 items-center gap-3 px-3.5">
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
