import { mcpManager } from '@/services/AgentService/infrastructure/mcp';
import { useMcpStore } from '@/stores/mcp';

export function useSearchInfrastructureController() {
    const mcpStore = useMcpStore();

    return {
        initializeMcpStore: () => mcpStore.initialize(),
        autoConnectMcp: () => mcpManager.autoConnect(),
    };
}
