<script setup lang="ts">
    import CustomSelect from '@components/CustomSelect.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { Textarea } from '@components/ui/textarea';
    import { storeToRefs } from 'pinia';
    import { computed, reactive, ref } from 'vue';

    import {
        addPromptSnippet,
        PROMPT_SNIPPET_BODY_MAX_LENGTH,
        PROMPT_SNIPPET_MAX_ITEMS,
        PROMPT_SNIPPET_TITLE_MAX_LENGTH,
        type PromptSnippet,
        type PromptSnippetInsertionMode,
        type PromptSnippetValidationCode,
        PromptSnippetValidationError,
        removePromptSnippet,
        sortPromptSnippets,
        toPromptSnippetStorage,
        updatePromptSnippet,
    } from '@/app/api/settings/preferences';
    import { t } from '@/i18n';
    import { useSettingsStore } from '@/stores/settings';

    defineOptions({
        name: 'PromptSnippetSettings',
    });

    const settingsStore = useSettingsStore();
    const { settings } = storeToRefs(settingsStore);

    const isEditing = ref(false);
    const editingId = ref<string | null>(null);
    const isSaving = ref(false);
    const validationCode = ref<PromptSnippetValidationCode | null>(null);
    const operationFailed = ref(false);
    const deleteCandidateId = ref<string | null>(null);
    const draft = reactive({
        title: '',
        body: '',
        isFavorite: false,
    });

    const snippets = computed(() => sortPromptSnippets(settings.value.promptSnippets.items));
    const insertionModeOptions = computed(() => [
        {
            value: 'paste_only' as const,
            label: t('settings.general.promptSnippets.pasteOnly'),
        },
        {
            value: 'paste_and_send' as const,
            label: t('settings.general.promptSnippets.pasteAndSend'),
        },
    ]);
    const isAtLimit = computed(() => snippets.value.length >= PROMPT_SNIPPET_MAX_ITEMS);
    const storageIssueMessage = computed(() => {
        const issue = settings.value.promptSnippets.storageIssue;
        if (issue === 'invalid_json') {
            return t('settings.general.promptSnippets.storageInvalid');
        }
        if (issue === 'invalid_items') {
            return t('settings.general.promptSnippets.itemsInvalid');
        }
        if (issue === 'too_many_items') {
            return t('settings.general.promptSnippets.limitReached', {
                count: PROMPT_SNIPPET_MAX_ITEMS,
            });
        }
        return '';
    });
    const validationMessage = computed(() => {
        if (!validationCode.value) {
            return '';
        }
        const messages: Record<PromptSnippetValidationCode, string> = {
            too_many_items: t('settings.general.promptSnippets.limitReached', {
                count: PROMPT_SNIPPET_MAX_ITEMS,
            }),
            not_found: t('settings.general.promptSnippets.notFound'),
            empty_title: t('settings.general.promptSnippets.titleRequired'),
            title_too_long: t('settings.general.promptSnippets.titleTooLong', {
                count: PROMPT_SNIPPET_TITLE_MAX_LENGTH,
            }),
            empty_body: t('settings.general.promptSnippets.bodyRequired'),
            body_too_long: t('settings.general.promptSnippets.bodyTooLong', {
                count: PROMPT_SNIPPET_BODY_MAX_LENGTH.toLocaleString('en-US'),
            }),
        };
        return messages[validationCode.value];
    });

    function resetDraft() {
        draft.title = '';
        draft.body = '';
        draft.isFavorite = false;
        validationCode.value = null;
        operationFailed.value = false;
    }

    function beginCreate() {
        editingId.value = null;
        resetDraft();
        isEditing.value = true;
    }

    function beginEdit(snippet: PromptSnippet) {
        editingId.value = snippet.id;
        draft.title = snippet.title;
        draft.body = snippet.body;
        draft.isFavorite = snippet.isFavorite;
        validationCode.value = null;
        isEditing.value = true;
    }

    function cancelEdit() {
        isEditing.value = false;
        editingId.value = null;
        resetDraft();
    }

    function newSnippetId(): string {
        return globalThis.crypto?.randomUUID?.() ?? `snippet-${Date.now()}`;
    }

    async function saveSnippet() {
        if (isSaving.value) {
            return;
        }
        const current = toPromptSnippetStorage(settings.value.promptSnippets);
        try {
            const next =
                editingId.value === null
                    ? addPromptSnippet(
                          current,
                          {
                              title: draft.title,
                              body: draft.body,
                              isFavorite: draft.isFavorite,
                          },
                          { id: newSnippetId(), now: new Date().toISOString() }
                      )
                    : updatePromptSnippet(
                          current,
                          editingId.value,
                          {
                              title: draft.title,
                              body: draft.body,
                              isFavorite: draft.isFavorite,
                          },
                          new Date().toISOString()
                      );
            isSaving.value = true;
            operationFailed.value = false;
            await settingsStore.updatePromptSnippets(next);
            cancelEdit();
        } catch (error) {
            if (error instanceof PromptSnippetValidationError) {
                validationCode.value = error.code;
                return;
            }
            validationCode.value = null;
            operationFailed.value = true;
        } finally {
            isSaving.value = false;
        }
    }

    async function updateInsertionMode(mode: PromptSnippetInsertionMode) {
        operationFailed.value = false;
        try {
            await settingsStore.updatePromptSnippetInsertionMode(mode);
        } catch {
            operationFailed.value = true;
        }
    }

    function requestDelete(snippetId: string) {
        deleteCandidateId.value = snippetId;
    }

    function cancelDelete() {
        deleteCandidateId.value = null;
    }

    async function confirmDelete(snippetId: string) {
        if (isSaving.value) {
            return;
        }
        isSaving.value = true;
        operationFailed.value = false;
        try {
            await settingsStore.updatePromptSnippets(
                removePromptSnippet(
                    toPromptSnippetStorage(settings.value.promptSnippets),
                    snippetId
                )
            );
            deleteCandidateId.value = null;
        } catch {
            operationFailed.value = true;
        } finally {
            isSaving.value = false;
        }
    }
</script>

<template>
    <section class="space-y-4" data-testid="settings-prompt-snippets">
        <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h2 class="settings-section-title">
                    {{ t('settings.general.promptSnippets.title') }}
                </h2>
                <p class="settings-section-description">
                    {{ t('settings.general.promptSnippets.description') }}
                </p>
            </div>
            <Button
                variant="outline-neutral"
                data-testid="prompt-snippet-add"
                :disabled="isEditing || isAtLimit"
                @click="beginCreate"
            >
                {{ t('settings.general.promptSnippets.add') }}
            </Button>
        </div>

        <div
            v-if="storageIssueMessage"
            data-testid="prompt-snippet-storage-error"
            class="rounded-control border border-border-warning bg-background-warning px-3 py-2 text-compact text-text-warning"
            role="status"
        >
            {{ storageIssueMessage }}
        </div>

        <div
            v-if="operationFailed"
            data-testid="prompt-snippet-operation-error"
            class="rounded-control border border-border-danger bg-background-danger px-3 py-2 text-compact text-text-danger"
            role="alert"
        >
            {{ t('settings.general.promptSnippets.operationFailed') }}
        </div>

        <div class="settings-row-group">
            <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <label class="text-compact font-medium text-text-primary" for="prompt-snippet-mode">
                    {{ t('settings.general.promptSnippets.insertionMode') }}
                </label>
                <CustomSelect
                    id="prompt-snippet-mode"
                    :model-value="settings.promptSnippetInsertionMode"
                    :options="insertionModeOptions"
                    :disabled="isSaving"
                    disable-portal
                    trigger-test-id="prompt-snippet-insertion-mode"
                    option-test-id-prefix="prompt-snippet-insertion-mode-"
                    @update:model-value="updateInsertionMode"
                />
            </div>
        </div>

        <form
            v-if="isEditing"
            class="space-y-3 rounded-control border border-border-subtle bg-surface-sunken p-4"
            data-testid="prompt-snippet-editor"
            @submit.prevent="saveSnippet"
        >
            <div class="space-y-1.5">
                <label
                    class="text-compact font-medium text-text-primary"
                    for="prompt-snippet-title"
                >
                    {{ t('settings.general.promptSnippets.snippetTitle') }}
                </label>
                <Input
                    id="prompt-snippet-title"
                    v-model="draft.title"
                    data-testid="prompt-snippet-title"
                    :placeholder="t('settings.general.promptSnippets.titlePlaceholder')"
                    :aria-invalid="
                        validationCode === 'empty_title' || validationCode === 'title_too_long'
                    "
                />
                <p class="text-dense text-text-tertiary">
                    {{
                        t('settings.general.promptSnippets.titleCount', {
                            count: draft.title.length,
                            max: PROMPT_SNIPPET_TITLE_MAX_LENGTH,
                        })
                    }}
                </p>
            </div>

            <div class="space-y-1.5">
                <label class="text-compact font-medium text-text-primary" for="prompt-snippet-body">
                    {{ t('settings.general.promptSnippets.snippetBody') }}
                </label>
                <Textarea
                    id="prompt-snippet-body"
                    v-model="draft.body"
                    data-testid="prompt-snippet-body"
                    :placeholder="t('settings.general.promptSnippets.bodyPlaceholder')"
                    :rows="6"
                    :aria-invalid="
                        validationCode === 'empty_body' || validationCode === 'body_too_long'
                    "
                />
                <p class="text-dense text-text-tertiary">
                    {{
                        t('settings.general.promptSnippets.bodyCount', {
                            count: draft.body.length,
                            max: PROMPT_SNIPPET_BODY_MAX_LENGTH,
                        })
                    }}
                </p>
            </div>

            <label class="flex items-center justify-between gap-3">
                <span class="text-compact font-medium text-text-primary">
                    {{ t('settings.general.promptSnippets.favorite') }}
                </span>
                <Switch
                    data-testid="prompt-snippet-favorite"
                    :model-value="draft.isFavorite"
                    @update:model-value="draft.isFavorite = $event"
                />
            </label>

            <p
                v-if="validationMessage"
                class="text-compact text-text-danger"
                data-testid="prompt-snippet-validation"
                role="alert"
            >
                {{ validationMessage }}
            </p>

            <div class="flex justify-end gap-2">
                <Button variant="outline-neutral" @click="cancelEdit">
                    {{ t('common.cancel') }}
                </Button>
                <Button
                    variant="strong"
                    type="submit"
                    data-testid="prompt-snippet-save"
                    :disabled="isSaving"
                >
                    {{ t('common.save') }}
                </Button>
            </div>
        </form>

        <div
            v-if="snippets.length === 0"
            class="rounded-control border border-dashed border-border-subtle px-4 py-8 text-center text-compact text-text-tertiary"
            data-testid="prompt-snippet-empty"
        >
            {{ t('settings.general.promptSnippets.empty') }}
        </div>

        <div v-else class="space-y-2">
            <article
                v-for="snippet in snippets"
                :key="snippet.id"
                class="rounded-control border border-border-subtle bg-surface-floating p-3"
                :data-testid="`prompt-snippet-row-${snippet.id}`"
            >
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            <h3 class="truncate text-compact font-medium text-text-primary">
                                {{ snippet.title }}
                            </h3>
                            <span
                                v-if="snippet.isFavorite"
                                class="rounded-full bg-primary-50 px-1.5 py-0.5 text-dense text-primary-700"
                            >
                                {{ t('settings.general.promptSnippets.favoriteBadge') }}
                            </span>
                        </div>
                        <p
                            class="mt-1 line-clamp-2 text-dense whitespace-pre-wrap text-text-tertiary"
                        >
                            {{ snippet.body }}
                        </p>
                    </div>
                    <div class="flex shrink-0 gap-1">
                        <Button variant="outline-neutral" @click="beginEdit(snippet)">
                            {{ t('common.edit') }}
                        </Button>
                        <Button
                            variant="danger"
                            :data-testid="`prompt-snippet-delete-${snippet.id}`"
                            @click="requestDelete(snippet.id)"
                        >
                            {{ t('common.delete') }}
                        </Button>
                    </div>
                </div>

                <div
                    v-if="deleteCandidateId === snippet.id"
                    class="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-3"
                >
                    <span class="mr-auto text-compact text-text-secondary">
                        {{ t('settings.general.promptSnippets.confirmDelete') }}
                    </span>
                    <Button variant="outline-neutral" @click="cancelDelete">
                        {{ t('common.cancel') }}
                    </Button>
                    <Button
                        variant="danger"
                        :data-testid="`prompt-snippet-confirm-delete-${snippet.id}`"
                        @click="confirmDelete(snippet.id)"
                    >
                        {{ t('common.delete') }}
                    </Button>
                </div>
            </article>
        </div>
    </section>
</template>
