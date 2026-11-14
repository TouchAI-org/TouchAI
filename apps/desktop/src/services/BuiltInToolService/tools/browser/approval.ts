import {
    BROWSER_SETTINGS_KEY,
    type BrowserPermissionMode,
    parseBrowserSettingsConfig,
} from '@services/SettingsService/domain/sections/browser';
import {
    type BrowserToolOperation,
    evaluateBrowserPermission,
    normalizeBrowserDescription,
} from '@services/SettingsService/domain/sections/browserPolicy';

import { tt } from '@/i18n';
import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import { readEffectiveSettingValue } from '../../settingsReader';
import {
    BROWSER_ACT_OPERATIONS,
    BROWSER_OBSERVE_OPERATIONS,
    BROWSER_OPERATIONS,
    BROWSER_SESSION_OPERATIONS,
} from './constants';
import type { BrowserToolId } from './index';
import { isBrowserToolOperation, parseBrowserOperation } from './operation';
import { redactBrowserText, redactUrl } from './redaction';

const APPROVAL_DELAY_MS = 450;

const APPROVAL_OPERATIONS_BY_TOOL: Record<BrowserToolId, ReadonlySet<BrowserToolOperation>> = {
    browser: new Set(BROWSER_OPERATIONS),
    browser_session: new Set(BROWSER_SESSION_OPERATIONS),
    browser_observe: new Set(BROWSER_OBSERVE_OPERATIONS),
    browser_act: new Set([...BROWSER_ACT_OPERATIONS, 'screenshot']),
};

function permissionOperationForApproval(
    toolId: BrowserToolId,
    operation: string
): BrowserToolOperation | null {
    if (!isBrowserToolOperation(operation)) {
        return null;
    }

    return APPROVAL_OPERATIONS_BY_TOOL[toolId]?.has(operation) ? operation : null;
}

async function browserPermissionDecision(
    operation: BrowserToolOperation,
    args: Record<string, unknown>
): Promise<BrowserPermissionMode> {
    const value = await readEffectiveSettingValue(BROWSER_SETTINGS_KEY);
    const settings = parseBrowserSettingsConfig(typeof value === 'string' ? value : null);
    const rawUrl = normalizeOptionalString(args.url, { collapseWhitespace: true });
    return evaluateBrowserPermission(settings, operation, { url: rawUrl }).decision;
}

function semanticDescription(args: Record<string, unknown>): string {
    return normalizeBrowserDescription(args.description) ?? '';
}

function approval(command: string, reason: string, description: string): ToolApprovalRequest {
    const displayCommand = description || command;
    return {
        title: tt('浏览器操作确认'),
        description,
        command: truncateText(displayCommand, 180),
        riskLabel: '',
        reason,
        commandLabel: '',
        approveLabel: tt('批准'),
        rejectLabel: tt('拒绝'),
        enterHint: 'Enter',
        escHint: 'Esc',
        keyboardApproveDelayMs: APPROVAL_DELAY_MS,
    };
}

function formatTarget(args: Record<string, unknown>): string {
    const ref = normalizeOptionalString(args.ref, { collapseWhitespace: true });
    if (ref) {
        return ref;
    }

    const selector = normalizeOptionalString(args.selector, { collapseWhitespace: true });
    return selector ? redactBrowserText(selector) : 'selected tab';
}

function formatFieldLabel(args: Record<string, unknown>): string {
    return (
        normalizeOptionalString(args.field, { collapseWhitespace: true }) ??
        normalizeOptionalString(args.name, { collapseWhitespace: true }) ??
        'field'
    );
}

function approvalForOperation(
    operation: BrowserToolOperation,
    args: Record<string, unknown>
): ToolApprovalRequest | null {
    const description = semanticDescription(args);

    switch (operation) {
        case 'status':
            return approval('status', tt('此操作会读取浏览器会话状态。'), description);
        case 'dom':
        case 'current':
        case 'tabs':
            return approval(operation, tt('此操作会读取当前浏览器页面或标签页状态。'), description);
        case 'start':
        case 'stop':
            return approval(operation, tt('此操作会启动或停止浏览器自动化会话。'), description);
        case 'navigate': {
            const rawUrl = normalizeOptionalString(args.url, { collapseWhitespace: true }) ?? '';
            const targetUrl = rawUrl ? redactUrl(rawUrl) : 'missing URL';
            return approval(
                `navigate ${targetUrl}`,
                tt('此操作会让浏览器打开或切换到新的网页。'),
                description
            );
        }
        case 'back':
        case 'forward':
        case 'reload':
            return approval(
                `${operation} ${formatTarget(args)}`,
                tt('此操作会改变当前网页的浏览状态。'),
                description
            );
        case 'scroll':
            return approval('scroll', tt('此操作会滚动当前网页。'), description);
        case 'wait':
            return approval('wait', tt('此操作会等待当前网页。'), description);
        case 'screenshot':
            return approval(
                `screenshot ${formatTarget(args)}`,
                tt('此操作会截取当前网页内容并作为图片附件返回。'),
                description
            );
        case 'fill': {
            const field = formatFieldLabel(args);
            return approval(
                `fill ${formatTarget(args)} ${redactBrowserText(field)}=[redacted]`,
                tt('此操作会向网页表单输入内容。'),
                description
            );
        }
        case 'fill_form':
            return approval(
                `fill_form ${formatTarget(args)}`,
                tt('此操作会向网页表单输入一组内容。'),
                description
            );
        case 'type':
            return approval(
                `type ${formatTarget(args)}`,
                tt('此操作会在网页中输入文本。'),
                description
            );
        case 'click':
        case 'press_key':
            return approval(
                `${operation} ${formatTarget(args)}`,
                tt('此操作会与网页交互，可能触发提交、导航或状态变更。'),
                description
            );
        case 'connect_existing':
            return null;
    }

    return null;
}

export async function createBrowserApprovalRequest(
    toolId: BrowserToolId,
    args: Record<string, unknown>
): Promise<ToolApprovalRequest | null> {
    const operation = parseBrowserOperation(args);
    // Connecting an existing session already needs a chooser whenever the policy asks.
    // The chooser is the single decision point; a separate approval card would ask twice.
    if (!operation || operation === 'connect_existing') {
        return null;
    }

    const permissionOperation = permissionOperationForApproval(toolId, operation);
    if (!permissionOperation) {
        return null;
    }

    if ((await browserPermissionDecision(permissionOperation, args)) !== 'ask') {
        return null;
    }

    return approvalForOperation(permissionOperation, args);
}
