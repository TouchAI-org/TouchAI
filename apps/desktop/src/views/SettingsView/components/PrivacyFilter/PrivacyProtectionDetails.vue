<script setup lang="ts">
    import { Button } from '@components/ui/button';
    import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';

    import { log } from '@/app/api/diagnostics';
    import {
        type PrivacyProtectionDetails,
        type PrivacyProtectionRecord,
        usePrivacyApi,
    } from '@/app/api/privacy';
    import { t } from '@/i18n';

    import { privacyProtectionContexts } from './privacyProtectionContext';

    const props = defineProps<{ record: PrivacyProtectionRecord }>();
    const emit = defineEmits<{ ready: [] }>();
    const privacyApi = usePrivacyApi();
    const details = shallowRef<PrivacyProtectionDetails | null>(null);
    const loading = ref(false);
    const loadFailed = ref(false);
    let requestSequence = 0;

    const contexts = computed(() =>
        details.value ? privacyProtectionContexts(details.value) : []
    );

    const stages = computed(() => {
        if (!contexts.value.length) return [];
        const restore = props.record.direction === 'restore';
        return [
            {
                label: t(
                    restore
                        ? 'settings.privacyFilter.records.details.beforeRestore'
                        : 'settings.privacyFilter.records.details.beforeMask'
                ),
                side: restore ? ('masked' as const) : ('original' as const),
            },
            {
                label: t(
                    props.record.outcome === 'blocked'
                        ? 'settings.privacyFilter.records.details.notSentShort'
                        : restore
                          ? 'settings.privacyFilter.records.details.afterRestore'
                          : 'settings.privacyFilter.records.details.afterMask'
                ),
                side: restore ? ('original' as const) : ('masked' as const),
                blocked: props.record.outcome === 'blocked',
            },
        ];
    });

    async function refresh(): Promise<void> {
        const sequence = ++requestSequence;
        loading.value = true;
        loadFailed.value = false;
        try {
            const next = await privacyApi.getRecordDetails(props.record.id);
            if (sequence === requestSequence) details.value = next;
        } catch {
            if (sequence !== requestSequence) return;
            loadFailed.value = true;
            log.warn('[PrivacyProtection] Could not read record details');
        } finally {
            if (sequence === requestSequence) {
                loading.value = false;
                emit('ready');
            }
        }
    }

    watch(
        () => props.record.id,
        () => {
            details.value = null;
            void refresh();
        },
        { immediate: true }
    );
    onBeforeUnmount(() => {
        requestSequence += 1;
    });
</script>

<template>
    <div
        class="space-y-3 px-4 pt-3 pb-4 font-serif text-muted-foreground"
        data-testid="privacy-protection-details"
        :aria-busy="loading"
    >
        <p v-if="record.outcome === 'blocked'" class="text-xs text-text-warning" role="status">
            {{ t('settings.privacyFilter.records.details.notSent') }}
        </p>
        <p v-if="loading" class="text-xs text-text-secondary" role="status">
            {{ t('common.loading') }}
        </p>
        <div v-else-if="loadFailed" class="flex items-center gap-3" role="alert">
            <p class="text-xs text-text-danger">
                {{ t('settings.privacyFilter.records.details.loadFailed') }}
            </p>
            <Button
                variant="outline-neutral"
                data-testid="privacy-protection-details-retry"
                @click="refresh"
            >
                {{ t('common.retry') }}
            </Button>
        </div>
        <p v-else-if="!stages.length" class="text-xs text-text-secondary" role="status">
            {{ t('settings.privacyFilter.records.details.unavailable') }}
        </p>
        <div
            v-else
            class="space-y-3"
            :aria-label="t('settings.privacyFilter.records.details.list')"
        >
            <div class="grid grid-cols-2 gap-3">
                <h4
                    v-for="stage in stages"
                    :key="stage.label"
                    class="px-0.5 text-caption font-normal"
                    data-testid="privacy-protection-stage-label"
                >
                    {{ stage.label }}
                </h4>
            </div>
            <section
                v-for="(context, contextIndex) in contexts"
                :key="contextIndex"
                class="min-w-0"
                data-testid="privacy-protection-context"
            >
                <div
                    class="settings-scrollbar max-h-96 overflow-y-auto overscroll-contain"
                    :tabindex="context.excerpts.length > 1 ? 0 : undefined"
                    :aria-label="t('settings.privacyFilter.records.details.list')"
                >
                    <div
                        class="grid grid-cols-2 items-stretch gap-3"
                        data-testid="privacy-protection-context-row"
                    >
                        <div
                            v-for="stage in stages"
                            :key="stage.label"
                            class="min-w-0 space-y-3 rounded-control border border-border-subtle bg-settings-surface p-3 text-caption leading-6 break-words whitespace-pre-wrap"
                            role="group"
                            :aria-label="stage.label"
                            data-testid="privacy-protection-stage"
                        >
                            <p v-if="stage.blocked">
                                {{ t('settings.privacyFilter.records.details.notSentShort') }}
                            </p>
                            <template v-else>
                                <p v-for="(paragraph, index) in context.excerpts" :key="index">
                                    <template
                                        v-for="(part, partIndex) in paragraph"
                                        :key="partIndex"
                                    >
                                        <span
                                            v-if="part.marked"
                                            class="rounded-sm bg-privacy-mark px-0.5 py-0.5"
                                            :data-testid="
                                                stage.side === 'original'
                                                    ? 'privacy-protection-value-original'
                                                    : 'privacy-protection-value-masked'
                                            "
                                            data-no-i18n="true"
                                            translate="no"
                                        >
                                            {{ part[stage.side] }}
                                        </span>
                                        <template v-else>{{ part[stage.side] }}</template>
                                    </template>
                                </p>
                            </template>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    </div>
</template>
