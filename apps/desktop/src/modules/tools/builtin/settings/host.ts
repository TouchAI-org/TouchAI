import type { SupportedSettingKey, SupportedSettingValue } from './constants';

export interface ToolSettingsCapabilities {
    read(key: SupportedSettingKey): Promise<SupportedSettingValue>;
    mutate(
        key: SupportedSettingKey,
        value: SupportedSettingValue
    ): Promise<
        | { status: 'committed'; warning?: string }
        | {
              status: 'rejected' | 'restored' | 'recovery-required' | 'unknown';
              code: string;
              message: string;
          }
    >;
}
