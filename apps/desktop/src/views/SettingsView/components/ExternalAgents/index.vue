<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { Switch } from '@components/ui/switch';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import { log } from '@/app/api/diagnostics';
    import {
        type ExternalAgentEntity,
        useExternalAgentsAdministrationApi,
    } from '@/app/api/tools/externalAgents';
    import { type MessageKey, t } from '@/i18n';
    import { formatDateTime } from '@/i18n/format';

    defineOptions({ name: 'SettingsExternalAgentsSection' });

    const administration = useExternalAgentsAdministrationApi();
    const alert = useAlert();
    const { confirm } = useConfirm();
    const agents = ref<ExternalAgentEntity[]>([]);
    const url = ref('');
    const allowLoopback = ref(false);
    const loading = ref(false);
    const discovering = ref(false);
    const busyId = ref<number | null>(null);
    const lifetime = new AbortController();

    const loopbackInput = computed(() => {
        try {
            const hostname = new URL(url.value.trim()).hostname
                .replace(/^\[/, '')
                .replace(/\]$/, '')
                .replace(/\.+$/, '')
                .toLowerCase();
            return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
        } catch {
            return false;
        }
    });
    const canAdd = computed(
        () =>
            Boolean(url.value.trim()) &&
            !discovering.value &&
            (!loopbackInput.value || allowLoopback.value)
    );
    const errorMessages: Record<string, MessageKey> = {
        agent_unavailable: 'externalAgents.error.agentUnavailable',
        auth_required: 'externalAgents.error.authRequired',
        card_malformed: 'externalAgents.error.cardMalformed',
        cancelled: 'externalAgents.error.cancelled',
        discovery_unavailable: 'externalAgents.error.discoveryUnavailable',
        interface_unavailable: 'externalAgents.error.interfaceUnavailable',
        invalid_response: 'externalAgents.error.invalidResponse',
        payload_too_large: 'externalAgents.error.payloadTooLarge',
        polling_timeout: 'externalAgents.error.pollingTimeout',
        request_failed: 'externalAgents.error.requestFailed',
        stream_disconnected: 'externalAgents.error.streamDisconnected',
        timeout: 'externalAgents.error.timeout',
        unsafe_url: 'externalAgents.error.unsafeUrl',
    };

    watch(url, () => {
        if (!loopbackInput.value) allowLoopback.value = false;
    });

    function errorText(code: string): string {
        const key = errorMessages[code];
        return key ? t(key) : code;
    }

    function discoveredText(value: string | null): string {
        if (!value) return t('settings.externalAgents.neverDiscovered');
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? value
            : t('settings.externalAgents.discoveredAt', { time: formatDateTime(date) });
    }

    async function loadAgents() {
        loading.value = true;
        try {
            const result = await administration.findAll();
            if (!lifetime.signal.aborted) agents.value = result;
        } catch (error) {
            if (lifetime.signal.aborted) return;
            log.error('[ExternalAgents] Failed to load agents:', error);
            alert.error(t('settings.externalAgents.loadFailed'));
        } finally {
            if (!lifetime.signal.aborted) loading.value = false;
        }
    }

    async function addAgent() {
        if (!canAdd.value) {
            if (loopbackInput.value && !allowLoopback.value)
                alert.warning(t('settings.externalAgents.loopbackConfirmationRequired'));
            return;
        }
        discovering.value = true;
        try {
            await administration.add({
                url: url.value.trim(),
                allowLoopback: loopbackInput.value && allowLoopback.value,
            });
            if (lifetime.signal.aborted) return;
            url.value = '';
            allowLoopback.value = false;
            alert.success(t('settings.externalAgents.added'));
            await loadAgents();
        } catch (error) {
            if (lifetime.signal.aborted) return;
            log.error('[ExternalAgents] Failed to discover agent:', error);
            alert.error(t('settings.externalAgents.addFailed'));
        } finally {
            if (!lifetime.signal.aborted) discovering.value = false;
        }
    }

    async function setEnabled(agent: ExternalAgentEntity, enabled: boolean) {
        if (busyId.value !== null) return;
        busyId.value = agent.id;
        try {
            await administration.updateEnabled(agent.id, enabled);
            if (!lifetime.signal.aborted) await loadAgents();
        } catch (error) {
            if (lifetime.signal.aborted) return;
            log.error('[ExternalAgents] Failed to update agent:', error);
            alert.error(t('settings.externalAgents.updateFailed'));
        } finally {
            if (!lifetime.signal.aborted) busyId.value = null;
        }
    }

    async function rediscover(agent: ExternalAgentEntity) {
        if (busyId.value !== null) return;
        busyId.value = agent.id;
        try {
            await administration.rediscover(agent.id);
            if (!lifetime.signal.aborted) {
                alert.success(t('settings.externalAgents.rediscovered'));
                await loadAgents();
            }
        } catch (error) {
            if (lifetime.signal.aborted) return;
            log.warn('[ExternalAgents] Rediscovery failed:', error);
            alert.error(t('settings.externalAgents.rediscoverFailed'));
            await loadAgents();
        } finally {
            if (!lifetime.signal.aborted) busyId.value = null;
        }
    }

    async function removeAgent(agent: ExternalAgentEntity) {
        if (busyId.value !== null) return;
        const confirmed = await confirm({
            title: t('settings.externalAgents.deleteTitle'),
            message: t('settings.externalAgents.deleteConfirm', { name: agent.name }),
            confirmText: t('common.delete'),
            cancelText: t('common.cancel'),
            type: 'danger',
        });
        if (!confirmed || lifetime.signal.aborted) return;
        busyId.value = agent.id;
        try {
            await administration.delete(agent.id);
            if (lifetime.signal.aborted) return;
            alert.success(t('settings.externalAgents.deleted'));
            await loadAgents();
        } catch (error) {
            if (lifetime.signal.aborted) return;
            log.error('[ExternalAgents] Failed to delete agent:', error);
            alert.error(t('settings.externalAgents.deleteFailed'));
        } finally {
            if (!lifetime.signal.aborted) busyId.value = null;
        }
    }

    onMounted(loadAgents);
    onUnmounted(() => lifetime.abort());
</script>

<template>
    <div class="settings-page">
        <div class="settings-section-stack">
            <header class="settings-page-header">
                <h1 class="settings-page-title">{{ t('settings.nav.externalAgents.label') }}</h1>
                <p class="settings-section-description">
                    {{ t('settings.externalAgents.description') }}
                </p>
            </header>

            <section class="space-y-4" data-settings-search-target="external-agents-add">
                <h2 class="settings-section-title">{{ t('settings.externalAgents.addTitle') }}</h2>
                <div class="settings-row-group p-5">
                    <div class="flex flex-col gap-3 sm:flex-row">
                        <Input
                            v-model="url"
                            type="url"
                            variant="filled"
                            autocomplete="url"
                            :placeholder="t('settings.externalAgents.urlPlaceholder')"
                            :disabled="discovering"
                            @keydown.enter.prevent="addAgent"
                        />
                        <Button variant="strong" :disabled="!canAdd" @click="addAgent">
                            {{ t('settings.externalAgents.discoverAndAdd') }}
                        </Button>
                    </div>
                    <label
                        v-if="loopbackInput"
                        class="mt-4 flex items-center justify-between gap-4 text-compact text-text-secondary"
                    >
                        <span>{{ t('settings.externalAgents.allowLoopback') }}</span>
                        <Switch v-model="allowLoopback" />
                    </label>
                </div>
            </section>

            <section class="space-y-4">
                <h2 class="settings-section-title">
                    {{ t('settings.externalAgents.registered') }}
                </h2>
                <div
                    v-if="!agents.length"
                    class="settings-row-group p-6 text-compact text-text-tertiary"
                >
                    {{ loading ? t('common.loading') : t('settings.externalAgents.empty') }}
                </div>
                <div v-else class="settings-row-group divide-y divide-border/70">
                    <article
                        v-for="agent in agents"
                        :key="agent.id"
                        class="flex flex-col gap-4 px-5 py-4"
                    >
                        <div
                            class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
                        >
                            <div class="min-w-0">
                                <div class="text-sm font-medium text-text-primary">
                                    {{ agent.name }}
                                </div>
                                <div class="mt-1 text-xs break-all text-text-tertiary">
                                    {{ agent.url }}
                                </div>
                            </div>
                            <Switch
                                :model-value="agent.enabled === 1"
                                :disabled="busyId !== null"
                                @update:model-value="setEnabled(agent, $event)"
                            />
                        </div>
                        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                            <span class="text-text-tertiary">
                                {{ discoveredText(agent.last_discovered_at) }}
                            </span>
                            <span v-if="agent.last_error" class="text-text-danger">
                                {{ errorText(agent.last_error) }}
                            </span>
                            <div class="ml-auto flex items-center gap-2">
                                <Button
                                    variant="outline-neutral"
                                    :disabled="busyId !== null"
                                    @click="rediscover(agent)"
                                >
                                    {{ t('common.retry') }}
                                </Button>
                                <Button
                                    variant="ghost-neutral"
                                    :disabled="busyId !== null"
                                    :aria-label="t('common.delete')"
                                    @click="removeAgent(agent)"
                                >
                                    <AppIcon name="delete" />
                                </Button>
                            </div>
                        </div>
                    </article>
                </div>
            </section>
        </div>
    </div>
</template>
