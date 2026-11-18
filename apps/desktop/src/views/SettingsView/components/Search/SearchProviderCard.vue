<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import PasswordInput from '@components/PasswordInput.vue';
    import { Badge } from '@components/ui/badge';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { SegmentedControl } from '@components/ui/segmented-control';
    import { Switch } from '@components/ui/switch';
    import { useMotion } from '@composables/useMotion';
    import { motion } from 'motion-v';
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
        logoHasBackground: boolean;
        endpointPlaceholder: string;
        keyPlaceholder: string;
        apiKeyRequired: boolean;
    }

    const props = defineProps<Props>();
    const { transitions, reducedMotion } = useMotion();
    const headerTransition = computed(() =>
        reducedMotion.value
            ? { duration: 0 }
            : { type: 'tween' as const, duration: 0.5, ease: [0.4, 0, 0.2, 1] }
    );

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
    >
        <div
            class="flex h-full min-w-0"
            :class="editing ? 'flex-col p-3.5' : ''"
            :data-testid="editing ? 'search-provider-editor' : undefined"
        >
            <motion.div
                v-if="editing"
                :initial="{ opacity: 0 }"
                :animate="{ opacity: 1 }"
                :transition="{ ...transitions.quick, delay: 0.14 }"
                class="absolute top-3.5 left-3.5 z-20"
            >
                <Button
                    variant="ghost"
                    size="icon-sm"
                    data-testid="search-provider-editor-back"
                    :aria-label="t('settings.search.editor.back')"
                    @click="emit('cancel')"
                >
                    <AppIcon name="arrow-left" class="size-4" />
                </Button>
            </motion.div>
            <div
                class="flex min-w-0 items-center gap-3"
                :class="editing ? 'w-full' : 'h-full flex-1 px-3.5'"
            >
                <motion.span
                    v-if="logo"
                    :initial="false"
                    :animate="{
                        width: editing ? 28 : 72,
                        height: editing ? 28 : 72,
                        marginLeft: editing ? 36 : 0,
                    }"
                    :transition="headerTransition"
                    class="flex shrink-0 items-center justify-center bg-surface-sunken"
                    :class="editing ? 'rounded-lg p-0.5' : 'rounded-2xl p-2'"
                >
                    <span
                        v-if="logoHasBackground"
                        class="flex size-full items-center justify-center overflow-hidden rounded-xl"
                    >
                        <img :src="logo" alt="" class="size-full rounded-xl object-cover" />
                    </span>
                    <span
                        v-else
                        class="flex size-full items-center justify-center overflow-hidden rounded-xl bg-surface-floating p-0.5"
                    >
                        <img :src="logo" alt="" class="size-full rounded-lg object-contain" />
                    </span>
                </motion.span>

                <div class="min-w-0 flex-1" :class="editing ? 'flex items-center' : ''">
                    <div class="flex min-w-0 items-center gap-1.5">
                        <h3
                            class="min-w-0 truncate text-compact leading-5 font-medium text-settings-text"
                            :title="label"
                        >
                            {{ label }}
                        </h3>
                        <Badge
                            v-if="!editing && quota"
                            variant="source"
                            :data-testid="`search-provider-quota-${id}`"
                            class="shrink-0"
                        >
                            {{ quota }}
                        </Badge>
                    </div>
                    <p
                        v-if="!editing"
                        class="m-0 mt-1 line-clamp-2 text-caption whitespace-pre-line text-text-secondary"
                        :title="description"
                    >
                        {{ description }}
                    </p>
                </div>

                <SegmentedControl
                    v-if="editing && supportsEndpoint && !endpointRequired"
                    v-model="field"
                    data-testid="search-provider-credential-tabs"
                    :options="fieldOptions"
                    :aria-label="t('settings.search.provider.credentialType')"
                />

                <div v-else-if="!editing" class="flex shrink-0 items-center gap-1">
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

            <motion.div
                v-if="editing"
                :initial="{ opacity: 0, y: -4 }"
                :animate="{ opacity: 1, y: 0 }"
                :transition="transitions.quick"
                class="mt-2 flex min-w-0 items-center gap-2"
            >
                <div class="min-w-0 flex-1">
                    <Input
                        v-if="field === 'endpoint'"
                        v-model="endpointDraft"
                        variant="filled"
                        class="h-9 text-xs"
                        type="url"
                        :data-testid="`search-${id}-base-url-input`"
                        :placeholder="endpointPlaceholder"
                        spellcheck="false"
                    />
                    <PasswordInput
                        v-else
                        v-model="keyDraft"
                        variant="filled"
                        :input-test-id="`search-${id}-api-key-input`"
                        :placeholder="keyPlaceholder"
                        class="!mt-0"
                        input-class="h-9 py-0 pr-10 text-xs"
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
            </motion.div>
        </div>
    </article>
</template>
