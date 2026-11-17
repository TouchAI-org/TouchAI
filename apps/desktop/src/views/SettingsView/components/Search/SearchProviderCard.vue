<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import PasswordInput from '@components/PasswordInput.vue';
    import { Badge } from '@components/ui/badge';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { nextTick, ref, watch } from 'vue';

    import { t } from '@/i18n';

    const props = defineProps<{
        id: string;
        label: string;
        description: string;
        logo: string;
        quota?: string | null;
        enabled: boolean;
        disabled: boolean;
        credential: string;
        placeholder: string;
        editable: boolean;
        endpoint: boolean;
        supportsEndpoint?: boolean;
        endpointValue?: string;
        endpointPlaceholder?: string;
        invalid: boolean;
    }>();
    const emit = defineEmits<{
        enabled: [value: boolean];
        credential: [value: string];
        endpoint: [value: string];
    }>();
    const root = ref<HTMLElement>();
    const editing = ref(false);
    const field = ref<'key' | 'endpoint'>('key');
    const value = ref('');

    async function beginEditing() {
        field.value = props.endpoint ? 'endpoint' : 'key';
        value.value = field.value === 'endpoint' ? (props.endpointValue ?? '') : props.credential;
        editing.value = true;
        await nextTick();
        root.value?.querySelector('input')?.focus();
    }

    function commitField() {
        if (field.value === 'endpoint') {
            emit('endpoint', value.value);
        } else {
            emit('credential', value.value);
        }
    }

    function switchField(next: 'key' | 'endpoint') {
        if (field.value === next) return;
        commitField();
        field.value = next;
        value.value = next === 'endpoint' ? (props.endpointValue ?? '') : props.credential;
    }

    function finishEditing(save: boolean) {
        if (!editing.value) return;
        if (save) commitField();
        editing.value = false;
    }

    function leaveCard(event: FocusEvent) {
        if (!root.value?.contains(event.relatedTarget as Node | null)) finishEditing(true);
    }

    watch(
        () => props.invalid,
        (invalid) => {
            if (invalid) void beginEditing();
        }
    );
    watch(
        () => props.disabled,
        (disabled) => {
            if (disabled) finishEditing(false);
        }
    );
</script>

<template>
    <article
        ref="root"
        data-testid="search-provider-row"
        :data-provider="id"
        class="flex min-w-0 items-center gap-3 rounded-panel border border-border-subtle bg-surface-floating p-4"
        @focusout="leaveCard"
    >
        <div class="flex size-10 shrink-0 items-center justify-center overflow-hidden">
            <img :src="logo" alt="" class="size-full object-contain" />
        </div>
        <div class="flex h-16 min-w-0 flex-1 flex-col gap-1">
            <div class="flex h-5 min-w-0 shrink-0 items-center gap-1.5">
                <span
                    class="min-w-0 truncate text-compact leading-5 font-medium text-settings-text"
                    :title="label"
                >
                    {{ label }}
                </span>
                <span
                    v-if="editing && supportsEndpoint && !endpoint"
                    class="flex shrink-0 items-center gap-0.5"
                >
                    <button
                        type="button"
                        class="rounded px-1 py-0.5 text-2xs"
                        :class="
                            field === 'key'
                                ? 'bg-surface-selected text-text-primary'
                                : 'text-text-tertiary hover:bg-surface-hover'
                        "
                        @click="switchField('key')"
                    >
                        {{ t('settings.search.provider.keyField') }}
                    </button>
                    <button
                        type="button"
                        class="rounded px-1 py-0.5 text-2xs"
                        :class="
                            field === 'endpoint'
                                ? 'bg-surface-selected text-text-primary'
                                : 'text-text-tertiary hover:bg-surface-hover'
                        "
                        @click="switchField('endpoint')"
                    >
                        {{ t('settings.search.provider.urlField') }}
                    </button>
                </span>
                <Badge
                    v-else-if="quota"
                    variant="source"
                    :data-testid="`search-provider-quota-${id}`"
                    class="shrink-0"
                >
                    {{ quota }}
                </Badge>
            </div>
            <div class="relative h-10 min-w-0">
                <p
                    v-if="!editing"
                    class="m-0 line-clamp-2 text-caption leading-5 text-text-secondary"
                    :title="description"
                >
                    {{ description }}
                </p>
                <div
                    v-else
                    class="absolute inset-0"
                    @keydown.enter.prevent="finishEditing(true)"
                    @keydown.esc.prevent.stop="finishEditing(false)"
                >
                    <Input
                        v-if="endpoint || field === 'endpoint'"
                        v-model="value"
                        variant="filled"
                        type="url"
                        :data-testid="`search-${id}-api-key-input`"
                        :aria-label="placeholder"
                        :aria-invalid="invalid"
                        :placeholder="
                            field === 'endpoint'
                                ? (endpointPlaceholder ?? placeholder)
                                : placeholder
                        "
                        :disabled="disabled"
                        class="h-10"
                        :class="invalid ? 'border-border-danger' : ''"
                        spellcheck="false"
                    />
                    <PasswordInput
                        v-else
                        v-model="value"
                        :input-test-id="`search-${id}-api-key-input`"
                        :placeholder="placeholder"
                        :disabled="disabled"
                        class="!mt-0"
                        :input-class="invalid ? 'h-10 border-border-danger' : 'h-10'"
                    />
                </div>
            </div>
        </div>
        <div class="flex shrink-0 items-center gap-1">
            <Switch
                :data-testid="`search-provider-toggle-${id}`"
                :aria-label="label"
                :model-value="enabled"
                :disabled="disabled"
                @update:model-value="emit('enabled', $event)"
            />
            <div class="flex items-center justify-center">
                <Button
                    v-if="editable"
                    variant="ghost"
                    size="icon-sm"
                    :data-testid="`search-provider-edit-${id}`"
                    :aria-label="
                        t(editing ? 'settings.search.finishEdit' : 'settings.search.editProvider', {
                            name: label,
                        })
                    "
                    :aria-pressed="editing"
                    :disabled="disabled"
                    @click="editing ? finishEditing(true) : beginEditing()"
                >
                    <AppIcon :name="editing ? 'check-circle' : 'edit'" class="size-4" />
                </Button>
            </div>
        </div>
    </article>
</template>
