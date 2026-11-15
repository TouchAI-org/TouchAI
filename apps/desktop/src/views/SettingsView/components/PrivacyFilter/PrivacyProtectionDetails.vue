<script setup lang="ts">
    import { Button } from '@components/ui/button';
    import { native } from '@services/NativeService';
    import type {
        PrivacyProtectionDetails,
        PrivacyProtectionRecord,
    } from '@services/NativeService/privacyFilter';
    import { log } from '@services/ObservabilityService';
    import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';

    import { getLocale, t } from '@/i18n';

    import { privacyProtectionRuleDescription } from './privacyProtectionLabels';

    const props = defineProps<{ record: PrivacyProtectionRecord }>();
    const PAGE_SIZE = 20;
    const details = shallowRef<PrivacyProtectionDetails | null>(null);
    const loading = ref(false);
    const loadFailed = ref(false);
    const visibleLimit = ref(PAGE_SIZE);
    let requestSequence = 0;
    const visibleValues = computed(() => details.value?.values.slice(0, visibleLimit.value) ?? []);

    async function refresh(): Promise<void> {
        const sequence = ++requestSequence;
        loading.value = true;
        loadFailed.value = false;
        try {
            const next = await native.privacyFilter.getRecordDetails(props.record.id);
            if (sequence === requestSequence) details.value = next;
        } catch {
            if (sequence !== requestSequence) return;
            loadFailed.value = true;
            log.warn('[PrivacyProtection] Could not read record details');
        } finally {
            if (sequence === requestSequence) loading.value = false;
        }
    }

    watch(
        () => props.record.id,
        () => {
            details.value = null;
            visibleLimit.value = PAGE_SIZE;
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
        class="mx-2 space-y-3 border-t border-border-subtle py-3"
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
        <p
            v-else-if="!details || !visibleValues.length"
            class="text-xs text-text-secondary"
            role="status"
        >
            {{ t('settings.privacyFilter.records.details.unavailable') }}
        </p>
        <template v-else>
            <table
                class="w-full table-fixed text-left text-xs"
                :aria-label="t('settings.privacyFilter.records.details.list')"
            >
                <thead class="text-text-secondary">
                    <tr>
                        <th scope="col" class="w-1/3 px-2 pb-2 font-medium">
                            {{ t('settings.privacyFilter.records.details.originalValue') }}
                        </th>
                        <th scope="col" class="w-1/3 px-2 pb-2 font-medium">
                            {{ t('settings.privacyFilter.records.details.replacement') }}
                        </th>
                        <th scope="col" class="w-1/3 px-2 pb-2 font-medium">
                            {{ t('settings.privacyFilter.records.details.matchedRule') }}
                        </th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-border-subtle text-text-primary">
                    <tr
                        v-for="value in visibleValues"
                        :key="value.placeholder"
                        data-testid="privacy-protection-value"
                    >
                        <td
                            class="px-2 py-3 align-top font-mono leading-relaxed break-words whitespace-pre-wrap"
                            data-testid="privacy-protection-value-original"
                        >
                            {{ value.original }}
                        </td>
                        <td
                            class="px-2 py-3 align-top font-mono leading-relaxed break-words whitespace-pre-wrap"
                            data-testid="privacy-protection-value-masked"
                        >
                            {{ value.placeholder }}
                        </td>
                        <td
                            class="space-y-1 px-2 py-3 align-top leading-relaxed break-words"
                            data-testid="privacy-protection-value-rule"
                        >
                            <template v-if="value.matches?.length">
                                <p v-for="(hit, index) in value.matches" :key="index">
                                    {{ privacyProtectionRuleDescription(hit, value.kind) }}
                                    <span
                                        v-if="hit.count > 1 || value.matches.length > 1"
                                        class="text-text-tertiary tabular-nums"
                                    >
                                        ×{{ hit.count.toLocaleString(getLocale()) }}
                                    </span>
                                </p>
                            </template>
                            <span v-else class="text-text-tertiary">
                                {{ t('settings.privacyFilter.records.details.ruleUnavailable') }}
                            </span>
                        </td>
                    </tr>
                </tbody>
            </table>
            <Button
                v-if="details && visibleLimit < details.values.length"
                variant="outline-neutral"
                data-testid="privacy-protection-values-more"
                @click="visibleLimit += PAGE_SIZE"
            >
                {{ t('settings.privacyFilter.records.details.moreValues') }}
            </Button>
        </template>
        <p v-if="details?.truncated" class="text-xs text-text-warning" role="status">
            {{ t('settings.privacyFilter.records.details.truncated') }}
        </p>
    </div>
</template>
