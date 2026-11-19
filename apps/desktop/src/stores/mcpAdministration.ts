import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';

import { log } from '@/app/api/diagnostics';
import { type McpServerEntity, useMcpAdministrationApi } from '@/app/api/tools/mcpAdministration';
import { useMcpStore } from '@/stores/mcp';

/** Settings-only editable projection; execution and saved configuration stay with main. */
export const useMcpAdministrationStore = defineStore('mcp-administration', () => {
    const administration = useMcpAdministrationApi();
    const catalog = useMcpStore();
    const servers = ref<McpServerEntity[]>([]);
    const loading = ref(false);
    const initialized = ref(false);
    let disposed = false;
    let generation = 0;
    let initialization: Promise<void> | undefined;
    onScopeDispose(() => {
        disposed = true;
        generation++;
    });

    async function loadServers() {
        const current = ++generation;
        loading.value = true;
        try {
            const result = await administration.findAllMcpServers();
            if (!disposed && current === generation) servers.value = result;
        } catch (error) {
            if (disposed || current !== generation) return;
            log.error('[McpStore] Failed to load servers:', error);
            throw error;
        } finally {
            if (!disposed && current === generation) loading.value = false;
        }
    }
    async function initialize() {
        if (disposed || initialized.value) return;
        if (initialization) return initialization;
        initialization = Promise.all([loadServers(), catalog.initialize()])
            .then(() => {
                if (!disposed) initialized.value = true;
            })
            .finally(() => {
                initialization = undefined;
            });
        return initialization;
    }
    return {
        servers,
        loading,
        initialized,
        initialize,
        loadServers,
        enabledServers: computed(() => servers.value.filter((server) => server.enabled)),
        serverById: computed(() => {
            const byId = new Map(servers.value.map((server) => [server.id, server]));
            return (id: number) => byId.get(id);
        }),
        getServerStatus: catalog.getServerStatus,
        getServerError: catalog.getServerError,
        getServerTools: catalog.getServerTools,
        loadServerTools: catalog.loadServerTools,
    };
});
