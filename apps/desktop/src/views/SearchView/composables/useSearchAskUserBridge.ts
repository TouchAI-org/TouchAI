import { useAskUserStore } from '@/stores/askUser';

export function useSearchAskUserBridge() {
    const askUserStore = useAskUserStore();

    return {
        askUserStore,
        hasCurrentRequest: () => Boolean(askUserStore.current),
    };
}
