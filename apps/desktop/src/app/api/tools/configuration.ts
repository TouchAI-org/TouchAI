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
    SearchConversationToolConfig,
    UpgradeModelChainEntry,
    UpgradeModelToolConfig,
} from '@/modules/tools/public';
export {
    DEFAULT_BASH_TOOL_CONFIG,
    DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG,
    getBrowserAutomationStartupUrlError,
    parseBashToolConfig,
    parseBrowserAutomationToolConfig,
    parseSearchConversationToolConfig,
    serializeBrowserAutomationToolConfig,
    serializeSearchConversationToolConfig,
} from '@/modules/tools/public';

export function parseUpgradeModelToolConfig(configJson: string | null): UpgradeModelToolConfig {
    return createUpgradeModelConfiguration({ tt }).parse(configJson);
}

export function serializeUpgradeModelToolConfig(config: UpgradeModelToolConfig): string {
    return createUpgradeModelConfiguration({ tt }).serialize(config);
}
