import { t } from '@/i18n';

export type BrowserAutomationMode = 'default' | 'custom';

export interface BrowserAutomationToolConfig {
    mode: BrowserAutomationMode;
    startupUrl: string;
}

export const DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG: BrowserAutomationToolConfig = {
    mode: 'default',
    startupUrl: '',
};

export function parseBrowserAutomationToolConfig(
    configJson: string | null
): BrowserAutomationToolConfig {
    if (!configJson) {
        return { ...DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG };
    }

    try {
        const parsed = JSON.parse(configJson) as Partial<BrowserAutomationToolConfig>;
        return {
            ...DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG,
            mode: parsed.mode === 'custom' ? 'custom' : 'default',
            startupUrl:
                typeof parsed.startupUrl === 'string'
                    ? parsed.startupUrl
                    : DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG.startupUrl,
        };
    } catch {
        return { ...DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG };
    }
}

export function serializeBrowserAutomationToolConfig(config: BrowserAutomationToolConfig): string {
    return JSON.stringify({
        mode: config.mode,
        startupUrl: config.startupUrl.trim(),
    });
}

export function getBrowserAutomationStartupUrlError(config: BrowserAutomationToolConfig): string {
    const startupUrl = config.startupUrl.trim();
    if (!startupUrl) {
        return '';
    }

    try {
        const url = new URL(startupUrl);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return '';
        }
    } catch {
        // handled below
    }

    return t('settings.builtInTools.browser.startupUrlInvalid');
}
