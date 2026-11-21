<script setup lang="ts">
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

    import { type QuickSearchStatus, useEverythingSetupApi } from '@/app/api/settings/everything';
    import { type MessageKey, t } from '@/i18n';
    import { detectDesktopPlatform } from '@/utils/platform';

    type SetupState = 'checking' | 'unavailable' | 'installing' | 'preparing' | 'ready' | 'error';
    type SetupPhase = 'checking' | 'idle' | 'installing' | 'preparing' | 'error';

    const MAX_STARTUP_READS = 10;
    const STATUS_INTERVAL_MS = 500;

    const isWindows = detectDesktopPlatform() === 'windows';
    const everythingApi = useEverythingSetupApi();
    const phase = ref<SetupPhase>('checking');
    const status = ref<QuickSearchStatus | null>(null);
    let disposed = false;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;

    const state = computed<SetupState>(() => {
        if (phase.value === 'installing') return 'installing';
        if (phase.value === 'preparing') return 'preparing';
        if (phase.value === 'error') return 'error';
        if (status.value && isReady(status.value)) return 'ready';
        if (phase.value === 'checking') return 'checking';
        return 'unavailable';
    });

    const statusKey = computed<MessageKey>(() => {
        switch (state.value) {
            case 'checking':
                return 'settings.search.everything.status.checking';
            case 'unavailable':
                return 'settings.search.everything.status.unavailable';
            case 'installing':
                return 'settings.search.everything.status.installing';
            case 'preparing':
                return 'settings.search.everything.status.preparing';
            case 'ready':
                return 'settings.search.everything.status.ready';
            case 'error':
                return 'settings.search.everything.status.error';
        }
        return 'settings.search.everything.status.unavailable';
    });

    const busy = computed(
        () =>
            phase.value === 'checking' ||
            phase.value === 'installing' ||
            phase.value === 'preparing'
    );
    const actionKey = computed<MessageKey>(() =>
        state.value === 'error'
            ? 'settings.search.everything.action.retry'
            : 'settings.search.everything.action.install'
    );
    const statusClass = computed(() =>
        state.value === 'error' ? 'text-text-danger' : 'text-text-tertiary'
    );

    onMounted(() => {
        if (isWindows) void checkCurrent();
    });

    onBeforeUnmount(() => {
        disposed = true;
        clearTimeout(statusTimer);
    });

    function isReady(snapshot: QuickSearchStatus): boolean {
        return (
            snapshot.provider === 'everything' &&
            snapshot.db_loaded &&
            snapshot.index_warmed &&
            !snapshot.last_error
        );
    }

    async function checkCurrent() {
        phase.value = 'checking';
        status.value = null;
        try {
            const current = await everythingApi.getStatus();
            if (disposed) return;
            status.value = current;
            if (isReady(current)) {
                phase.value = 'idle';
                return;
            }

            await everythingApi.prepareIndex(true);
            if (!disposed) await pollStatus(1, false);
        } catch {
            if (!disposed) phase.value = 'error';
        }
    }

    async function installAndEnable() {
        if (busy.value || disposed) return;
        phase.value = 'installing';
        status.value = null;
        try {
            await everythingApi.installEverything();
            if (disposed) return;
            await everythingApi.prepareIndex(true);
            if (!disposed) await pollStatus(1, true);
        } catch {
            if (!disposed) phase.value = 'error';
        }
    }

    async function pollStatus(attempt: number, afterInstall: boolean) {
        try {
            const current = await everythingApi.getStatus();
            if (disposed) return;
            status.value = current;

            if (isReady(current)) {
                phase.value = 'idle';
                return;
            }

            if (current.provider === 'unavailable') {
                if (!afterInstall || attempt >= MAX_STARTUP_READS) {
                    phase.value = afterInstall ? 'error' : 'idle';
                    return;
                }
                phase.value = afterInstall ? 'installing' : 'checking';
            } else {
                phase.value = 'preparing';
                // Everything can still be loading its database after launch.
                // Retry preparation so the row can finish instead of waiting forever.
                await everythingApi.prepareIndex(true);
                if (disposed) return;
            }

            statusTimer = setTimeout(() => {
                void pollStatus(attempt + 1, afterInstall);
            }, STATUS_INTERVAL_MS);
        } catch {
            if (!disposed) phase.value = 'error';
        }
    }
</script>

<template>
    <SettingsRow
        v-if="isWindows"
        control-width="auto"
        data-settings-search-target="search-everything"
        data-testid="everything-setup"
        :label="t('settings.search.everything.label')"
    >
        <div class="flex items-center justify-end gap-3">
            <span
                class="text-caption whitespace-nowrap"
                :class="statusClass"
                data-testid="everything-status"
                role="status"
            >
                {{ t(statusKey) }}
            </span>
            <Button
                v-if="state !== 'ready'"
                variant="outline-neutral"
                data-testid="everything-install"
                :disabled="busy"
                :aria-busy="busy"
                @click="installAndEnable"
            >
                {{ t(actionKey) }}
            </Button>
        </div>
    </SettingsRow>
</template>
