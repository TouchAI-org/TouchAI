export * from './contracts/results';
export * from './domain';
export type { SettingsRejectionKind } from './domain/policy';
export { SettingsRejection } from './domain/policy';

import type { SettingsChangeNotice, SettingsMutationResult } from './contracts/results';
import type { GeneralSettingKey, GeneralSettingsData, GeneralSettingValue } from './domain';

/** Preference commands and cloned projections only; no owner disposal or business secrets. */
export interface SettingsApi {
    initialize(): Promise<void>;
    refresh(): Promise<void>;
    getSnapshot(): GeneralSettingsData;
    subscribe(listener: (notice: SettingsChangeNotice) => void): () => void;
    readEffectiveValue(key: GeneralSettingKey): Promise<GeneralSettingValue>;
    mutate(key: GeneralSettingKey, value: GeneralSettingValue): Promise<SettingsMutationResult>;
}
