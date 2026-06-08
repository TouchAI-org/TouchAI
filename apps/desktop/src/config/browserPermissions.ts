import type { BrowserPermissionMode, BrowserSettingsConfig } from '@/config/browserSettings';

export type BrowserToolOperation =
    | 'status'
    | 'start'
    | 'stop'
    | 'current'
    | 'tabs'
    | 'screenshot'
    | 'dom'
    | 'navigate'
    | 'click'
    | 'type'
    | 'fill'
    | 'fill_form'
    | 'press_key'
    | 'scroll'
    | 'wait'
    | 'back'
    | 'forward'
    | 'reload'
    | 'connect_existing';

export interface BrowserPermissionMetadata {
    url?: string | null;
    availableSessionCount?: number | null;
}

export interface BrowserPermissionDecision {
    decision: BrowserPermissionMode;
    reason: string;
}

const FIXED_BROWSER_DESCRIPTIONS: Partial<Record<BrowserToolOperation, string>> = {
    status: '查看浏览器状态',
    tabs: '查看浏览器标签页',
    current: '查看当前页面',
};

export function fixedBrowserDescription(operation: BrowserToolOperation): string | null {
    return FIXED_BROWSER_DESCRIPTIONS[operation] ?? null;
}

export function requiresBrowserDescription(operation: BrowserToolOperation): boolean {
    return fixedBrowserDescription(operation) === null;
}

export function normalizeBrowserDescription(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized ? normalized : null;
}

function permissionForOperation(
    config: BrowserSettingsConfig,
    operation: BrowserToolOperation
): BrowserPermissionMode {
    switch (operation) {
        case 'navigate':
            return config.permissions.navigate;
        case 'connect_existing':
            return config.permissions.connectExisting;
        case 'screenshot':
            return config.permissions.screenshot;
        case 'dom':
        case 'current':
        case 'tabs':
            return config.permissions.observeDom;
        case 'click':
        case 'press_key':
        case 'scroll':
        case 'wait':
            return config.permissions.click;
        case 'type':
            return config.permissions.type;
        case 'fill':
            return config.permissions.fillForm;
        case 'fill_form':
            return config.permissions.fillForm;
        case 'back':
        case 'forward':
        case 'reload':
            return config.permissions.history;
        case 'start':
        case 'stop':
        case 'status':
            return config.permissions.diagnostics;
    }
}

function hostnameFromUrl(value: string | null | undefined): string | null {
    if (!value) {
        return null;
    }

    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function domainMatches(hostname: string, domain: string): boolean {
    const normalizedDomain = domain.trim().toLowerCase();
    if (!normalizedDomain) {
        return false;
    }

    return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
}

function hasDomainMatch(
    hostname: string | null,
    rules: Array<{ domain: string }>
): boolean {
    return Boolean(hostname && rules.some((rule) => domainMatches(hostname, rule.domain)));
}

function existingSessionDecision(
    config: BrowserSettingsConfig,
    metadata: BrowserPermissionMetadata
): BrowserPermissionDecision | null {
    const count = metadata.availableSessionCount ?? 0;
    if (count > 1) {
        return {
            decision: 'ask',
            reason: 'multiple-existing-browser-sessions-require-user-selection',
        };
    }

    if (config.existingSessionPolicy === 'deny') {
        return { decision: 'deny', reason: 'existing-browser-session-policy-deny' };
    }

    if (config.existingSessionPolicy === 'ask') {
        return { decision: 'ask', reason: 'existing-browser-session-policy-ask' };
    }

    return null;
}

export function evaluateBrowserPermission(
    config: BrowserSettingsConfig,
    operation: BrowserToolOperation,
    metadata: BrowserPermissionMetadata = {}
): BrowserPermissionDecision {
    if (!config.enabled) {
        return { decision: 'deny', reason: 'browser-automation-disabled' };
    }

    if (operation === 'connect_existing' && (metadata.availableSessionCount ?? 0) > 1) {
        return {
            decision: 'ask',
            reason: 'multiple-existing-browser-sessions-require-user-selection',
        };
    }

    const hostname = hostnameFromUrl(metadata.url);
    if (hasDomainMatch(hostname, config.blockedDomains)) {
        return { decision: 'deny', reason: 'domain-blocked' };
    }

    if (config.permissionMode === 'allow') {
        return { decision: 'allow', reason: 'permission-mode-allow' };
    }

    if (config.permissionMode === 'deny') {
        return { decision: 'deny', reason: 'permission-mode-deny' };
    }

    if (operation === 'connect_existing') {
        const sessionDecision = existingSessionDecision(config, metadata);
        if (sessionDecision) {
            return sessionDecision;
        }
    }

    const operationPermission = permissionForOperation(config, operation);

    if (
        operation === 'navigate' &&
        operationPermission === 'ask' &&
        hasDomainMatch(hostname, config.allowedDomains)
    ) {
        return { decision: 'allow', reason: 'domain-allowed' };
    }

    return { decision: operationPermission, reason: `operation-${operationPermission}` };
}
