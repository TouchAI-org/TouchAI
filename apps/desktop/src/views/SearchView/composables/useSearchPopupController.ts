import { popupManager as popupService } from '@services/PopupService';

import type { SearchPopupSessionIdentity } from './searchInteraction';

export function useSearchPopupController() {
    function isLivePopupSession(identity: SearchPopupSessionIdentity | null): boolean {
        return (
            popupService.state.isOpen === true &&
            identity !== null &&
            popupService.state.currentPopupId === identity.popupId &&
            popupService.state.currentWindowLabel === identity.windowLabel &&
            popupService.state.currentPopupSessionVersion === identity.popupSessionVersion
        );
    }

    return {
        initialize: () => popupService.initialize(),
        isSessionHistoryOpen: () =>
            popupService.state.isOpen && popupService.state.currentType === 'session-history-popup',
        isLivePopupSession,
    };
}
