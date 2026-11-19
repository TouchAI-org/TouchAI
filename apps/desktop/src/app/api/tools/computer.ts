import { inject, type InjectionKey } from 'vue';

import type { ComputerAdministration } from '@/modules/tools/public';

export type {
    ComputerUseApproval,
    ComputerUseDriverId,
    ComputerUseGroup,
    ComputerUseGroups,
    ComputerUseSettings,
    ComputerUseStatus,
    ComputerUseUpdate,
} from '@/modules/tools/public';
export {
    COMPUTER_USE_GROUPS,
    DEFAULT_COMPUTER_USE_SETTINGS as DEFAULT_SETTINGS,
} from '@/modules/tools/public';
export type ComputerAdministrationApi = ComputerAdministration;
export class ComputerCommandError extends Error {
    constructor(
        readonly code:
            | 'COMPUTER_COMMAND_UNAVAILABLE'
            | 'COMPUTER_COMMAND_UNCONFIRMED'
            | 'COMPUTER_COMMAND_FAILED',
        readonly outcome: 'none' | 'unknown'
    ) {
        super(code);
        this.name = 'ComputerCommandError';
    }
}
export const computerAdministrationApiKey: InjectionKey<ComputerAdministrationApi> = Symbol(
    'touchai.tools.computer.administration'
);
export function useComputerAdministrationApi(): ComputerAdministrationApi {
    const api = inject(computerAdministrationApiKey);
    if (!api) throw new ComputerCommandError('COMPUTER_COMMAND_UNAVAILABLE', 'none');
    return api;
}
