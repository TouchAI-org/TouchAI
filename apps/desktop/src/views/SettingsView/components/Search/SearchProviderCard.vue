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
    import { AnimatePresence, motion } from 'motion-v';
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
            : { type: 'tween' as const, duration: 0.8, ease: [0.4, 0, 0.2, 1] }
    );
    const backTransition = computed(() =>
        reducedMotion.value ? { duration: 0 } : { ...transitions.value.quick, delay: 0.66 }
    );
    const ease = [0.4, 0, 0.2, 1] as const;
    const contentEnterTransition = computed(() =>
        reducedMotion.value
            ? { duration: 0 }
            : { type: 'tween' as const, duration: 0.28, delay: 0.16, ease }
    );
    const contentExitTransition = computed(() =>
        reducedMotion.value ? { duration: 0 } : { type: 'tween' as const, duration: 0.16, ease }
    );
    const tabsEnterTransition = computed(() =>
        reducedMotion.value
            ? { duration: 0 }
            : { type: 'tween' as const, duration: 0.22, delay: 0.2, ease }
    );
    const fieldsEnterTransition = computed(() =>
        reducedMotion.value
            ? { duration: 0 }
            : { type: 'tween' as const, duration: 0.3, delay: 0.28, ease }
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
        class="relative h-26 min-w-0 overflow-hidden rounded-card border border-border-subtle bg-surface-floating"
    >
        <div class="relative h-full" :data-testid="editing ? 'search-provider-editor' : undefined">
            <AnimatePresence :initial="false">
                <motion.div
                    v-if="editing"
                    key="back"
                    :initial="{ opacity: 0 }"
                    :animate="{ opacity: 1 }"
                    :exit="{ opacity: 0, transition: { duration: 0.15 } }"
                    :transition="backTransition"
                    class="absolute top-3.5 left-3.5 z-30"
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
            </AnimatePresence>

            <motion.span
                v-if="logo"
                :initial="false"
                :animate="{
                    x: editing ? 0 : -36,
                    y: editing ? 0 : 2,
                    width: editing ? 28 : 72,
                    height: editing ? 28 : 72,
                    padding: editing ? 2 : 8,
                    borderRadius: editing ? 8 : 16,
                }"
                :transition="headerTransition"
                class="absolute flex items-center justify-center bg-surface-sunken"
                style="left: 50px; top: 14px"
            >
                <span
                    v-if="logoHasBackground"
                    class="flex size-full items-center justify-center overflow-hidden rounded-xl"
                >
                    <img :src="logo" alt="" class="size-full rounded-xl object-cover" />
                </span>
                <span
                    v-else
                    class="flex size-full items-center justify-center overflow-hidden rounded-xl bg-surface-floating"
                    :class="editing ? 'p-0.5' : 'p-1.5'"
                >
                    <img :src="logo" alt="" class="size-full rounded-lg object-contain" />
                </span>
            </motion.span>

            <motion.div
                :initial="false"
                :animate="{ x: editing ? 0 : 8, y: editing ? 0 : 6 }"
                :transition="headerTransition"
                class="absolute flex min-w-0 items-center gap-1.5"
                style="left: 90px; top: 18px; right: 100px"
            >
                <h3
                    class="min-w-0 truncate text-compact leading-5 font-medium text-settings-text"
                    :title="label"
                >
                    {{ label }}
                </h3>
                <AnimatePresence :initial="false">
                    <motion.span
                        v-if="!editing && quota"
                        key="quota"
                        :initial="{ opacity: 0, scale: 0.92 }"
                        :animate="{ opacity: 1, scale: 1 }"
                        :exit="{
                            opacity: 0,
                            scale: 0.92,
                            transition: contentExitTransition,
                        }"
                        :transition="contentEnterTransition"
                        class="shrink-0"
                    >
                        <Badge variant="source" :data-testid="`search-provider-quota-${id}`">
                            {{ quota }}
                        </Badge>
                    </motion.span>
                </AnimatePresence>
            </motion.div>

            <AnimatePresence :initial="false">
                <motion.p
                    v-if="!editing"
                    key="description"
                    :initial="{ opacity: 0, y: -4 }"
                    :animate="{ opacity: 1, y: 0 }"
                    :exit="{
                        opacity: 0,
                        y: -4,
                        transition: contentExitTransition,
                    }"
                    :transition="contentEnterTransition"
                    class="absolute m-0 line-clamp-2 overflow-hidden text-caption whitespace-pre-line text-text-secondary"
                    style="left: 98px; top: 48px; right: 100px"
                    :title="description"
                >
                    {{ description }}
                </motion.p>
            </AnimatePresence>

            <AnimatePresence :initial="false">
                <motion.div
                    v-if="editing && supportsEndpoint && !endpointRequired"
                    key="tabs"
                    :initial="{ opacity: 0, x: 8 }"
                    :animate="{ opacity: 1, x: 0 }"
                    :exit="{ opacity: 0, x: 8, transition: contentExitTransition }"
                    :transition="tabsEnterTransition"
                    class="absolute top-3.5 right-3.5 z-20"
                >
                    <SegmentedControl
                        v-model="field"
                        data-testid="search-provider-credential-tabs"
                        :options="fieldOptions"
                        :aria-label="t('settings.search.provider.credentialType')"
                    />
                </motion.div>
            </AnimatePresence>

            <AnimatePresence :initial="false">
                <motion.div
                    v-if="!editing"
                    key="actions"
                    :initial="{ opacity: 0, x: 8 }"
                    :animate="{ opacity: 1, x: 0 }"
                    :exit="{ opacity: 0, x: 8, transition: contentExitTransition }"
                    :transition="contentEnterTransition"
                    class="absolute top-9 right-3.5 flex items-center gap-1"
                >
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
                </motion.div>
            </AnimatePresence>

            <AnimatePresence :initial="false">
                <motion.div
                    v-if="editing"
                    key="fields"
                    :initial="{ opacity: 0, y: 8 }"
                    :animate="{ opacity: 1, y: 0 }"
                    :exit="{ opacity: 0, y: 8, transition: contentExitTransition }"
                    :transition="fieldsEnterTransition"
                    class="absolute inset-x-3.5 bottom-3.5 flex items-center gap-2"
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
            </AnimatePresence>
        </div>
    </article>
</template>
