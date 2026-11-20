import { tt } from '@/i18n';
import {
    createUpgradeModelConfiguration,
    type UpgradeModelToolConfig,
} from '@/modules/tools/public';

export type {
    BashApprovalMode,
    BashToolConfig,
    BrowserAutomationMode,
    BrowserAutomationToolConfig,
    UpgradeModelChainEntry,
    UpgradeModelToolConfig,
} from '@/modules/tools/public';
export {
    DEFAULT_BASH_TOOL_CONFIG,
    DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG,
    getBrowserAutomationStartupUrlError,
    parseBashToolConfig,
    parseBrowserAutomationToolConfig,
    serializeBrowserAutomationToolConfig,
} from '@/modules/tools/public';

export function parseUpgradeModelToolConfig(configJson: string | null): UpgradeModelToolConfig {
    return createUpgradeModelConfiguration({ tt }).parse(configJson);
}

export function serializeUpgradeModelToolConfig(config: UpgradeModelToolConfig): string {
    return createUpgradeModelConfiguration({ tt }).serialize(config);
}
