import { getSettingValue } from '@database/queries';

import { tt } from '@/i18n';
import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';
import {
    BROWSER_SETTINGS_KEY,
    parseBrowserSettingsConfig,
} from '@/stores/setting/sections/browser';
import {
    type BrowserToolOperation,
    evaluateBrowserPermission,
    normalizeBrowserDescription,
} from '@/stores/setting/sections/browserPermissions';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import type { BrowserToolId } from './index';
import { parseBrowserOperation } from './operation';
import { redactBrowserText, redactUrl } from './redaction';

const APPROVAL_DELAY_MS = 450;

function permissionOperationForApproval(
    toolId: BrowserToolId,
    operation: string
): BrowserToolOperation | null {
    if (toolId === 'browser') {
        if (operation === 'start' || operation === 'stop') {
            return operation;
        }
        if (operation === 'screenshot') {
            return 'screenshot';
        }
        if (
            operation === 'navigate' ||
            operation === 'click' ||
            operation === 'type' ||
            operation === 'fill' ||
            operation === 'fill_form' ||
            operation === 'press_key' ||
            operation === 'back' ||
            operation === 'forward' ||
            operation === 'reload'
        ) {
            return operation as BrowserToolOperation;
        }
        return null;
    }

    if (toolId === 'browser_session') {
        return operation === 'start' || operation === 'stop' ? operation : null;
    }

    if (toolId === 'browser_observe') {
        return operation === 'screenshot' ? 'screenshot' : null;
    }

    if (toolId !== 'browser_act') {
        return null;
    }

    if (
        operation === 'navigate' ||
        operation === 'click' ||
        operation === 'type' ||
        operation === 'fill' ||
        operation === 'fill_form' ||
        operation === 'press_key' ||
        operation === 'back' ||
        operation === 'forward' ||
        operation === 'reload'
    ) {
        return operation as BrowserToolOperation;
    }

    if (operation === 'screenshot') {
        return 'screenshot';
    }

    return null;
}

async function isApprovalAllowedByBrowserSettings(
    toolId: BrowserToolId,
    operation: string,
    args: Record<string, unknown>
): Promise<boolean> {
    const permissionOperation = permissionOperationForApproval(toolId, operation);
    if (!permissionOperation) {
        return false;
    }

    const settings = parseBrowserSettingsConfig(
        await getSettingValue({ key: BROWSER_SETTINGS_KEY })
    );
    const rawUrl = normalizeOptionalString(args.url, { collapseWhitespace: true });
    const decision = evaluateBrowserPermission(settings, permissionOperation, { url: rawUrl });
    return decision.decision === 'allow';
}
function semanticDescription(args: Record<string, unknown>): string {
    return normalizeBrowserDescription(args.description) ?? '';
}

function approval(command: string, reason: string, description = ''): ToolApprovalRequest {
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

export async function createBrowserApprovalRequest(
    toolId: BrowserToolId,
    args: Record<string, unknown>
): Promise<ToolApprovalRequest | null> {
    const operation = parseBrowserOperation(args);
    if (!operation) {
        return null;
    }

    if (await isApprovalAllowedByBrowserSettings(toolId, operation, args)) {
        return null;
    }

    if (toolId === 'browser_observe' || (toolId === 'browser' && operation === 'screenshot')) {
        if (operation === 'screenshot') {
            return approval(
                `screenshot ${formatTarget(args)}`,
                tt('此操作会截取当前网页内容并作为图片附件返回。'),
                semanticDescription(args)
            );
        }

        return null;
    }

    if (
        toolId === 'browser_session' ||
        (toolId === 'browser' && (operation === 'start' || operation === 'stop'))
    ) {
        if (operation === 'start' || operation === 'stop') {
            return approval(
                operation,
                tt('此操作会启动或停止浏览器自动化会话。'),
                semanticDescription(args)
            );
        }

        return null;
    }

    if (toolId !== 'browser_act' && toolId !== 'browser') {
        return null;
    }

    if (operation === 'scroll' || operation === 'wait') {
        return null;
    }

    if (operation === 'navigate') {
        const rawUrl = normalizeOptionalString(args.url, { collapseWhitespace: true }) ?? '';
        const targetUrl = rawUrl ? redactUrl(rawUrl) : 'missing URL';
        return approval(
            `navigate ${targetUrl}`,
            tt('此操作会让浏览器打开或切换到新的网页。'),
            semanticDescription(args)
        );
    }

    if (operation === 'back' || operation === 'forward' || operation === 'reload') {
        return approval(
            `${operation} ${formatTarget(args)}`,
            tt('此操作会改变当前网页的浏览状态。'),
            semanticDescription(args)
        );
    }

    if (operation === 'screenshot') {
        return approval(
            `screenshot ${formatTarget(args)}`,
            tt('此操作会截取当前网页内容并作为图片附件返回。'),
            semanticDescription(args)
        );
    }

    if (operation === 'fill') {
        const field = formatFieldLabel(args);
        return approval(
            `fill ${formatTarget(args)} ${redactBrowserText(field)}=[redacted]`,
            tt('此操作会向网页表单输入内容。'),
            semanticDescription(args)
        );
    }

    if (operation === 'fill_form') {
        return approval(
            `fill_form ${formatTarget(args)}`,
            tt('此操作会向网页表单输入一组内容。'),
            semanticDescription(args)
        );
    }

    if (operation === 'type') {
        return approval(
            `type ${formatTarget(args)}`,
            tt('此操作会在网页中输入文本。'),
            semanticDescription(args)
        );
    }

    if (operation === 'click' || operation === 'press_key') {
        return approval(
            `${operation} ${formatTarget(args)}`,
            tt('此操作会与网页交互，可能触发提交、导航或状态变更。'),
            semanticDescription(args)
        );
    }

    return null;
}
