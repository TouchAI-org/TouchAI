// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type {
    ComputerActionReceipt,
    ComputerActionRequest,
    ComputerActionResponse,
    ComputerCapability,
    ComputerObservationInclude,
    ComputerObservationRequest,
    ComputerObservationResponse,
    ComputerSessionRequest,
    ComputerSessionResponse,
    ComputerTarget,
} from '@services/NativeService';

import { parseToolArguments, parseToolConfigJson } from '../../utils/toolSchema';
import {
    COMPUTER_ACT_TOOL_NAME,
    COMPUTER_OBSERVE_TOOL_NAME,
    COMPUTER_SESSION_TOOL_NAME,
    computerActArgsSchema,
    computerObserveArgsSchema,
    computerSessionArgsSchema,
    type ComputerToolConfig,
    computerToolConfigSchema,
    DEFAULT_COMPUTER_TOOL_CONFIG,
} from './constants';

const DEFAULT_SESSION_CAPABILITIES: ComputerCapability[] = [
    'native_tree',
    'screenshot',
    'background_actions',
];

const DEFAULT_OBSERVE_INCLUDES: ComputerObservationInclude[] = ['displays', 'windows', 'tree'];

export function parseComputerToolConfig(configJson: string | null): ComputerToolConfig {
    return parseToolConfigJson(computerToolConfigSchema, configJson, DEFAULT_COMPUTER_TOOL_CONFIG);
}

function cleanTarget(target: ComputerTarget): ComputerTarget {
    const normalized: ComputerTarget = {
        ...target,
        windowId: target.windowId ?? target.window?.id,
        elementId: target.elementId ?? target.element?.id,
        x: target.x ?? target.coordinates?.x,
        y: target.y ?? target.coordinates?.y,
        width: target.width ?? target.coordinates?.width,
        height: target.height ?? target.coordinates?.height,
        displayId: target.displayId ?? target.coordinates?.displayId,
    };

    return Object.fromEntries(
        Object.entries(normalized).filter(([, value]) => value !== undefined)
    ) as ComputerTarget;
}

function defaultProviderHints(config: ComputerToolConfig): string[] {
    return config.providerHints.filter((providerHint) => {
        if (providerHint === 'cua' || providerHint === 'omniparser' || providerHint === 'ui_tars') {
            return config.enableVisionFallback;
        }

        return true;
    });
}

function defaultCapabilities(config: ComputerToolConfig): ComputerCapability[] {
    return config.enableVisionFallback
        ? [...DEFAULT_SESSION_CAPABILITIES, 'vision_fallback']
        : DEFAULT_SESSION_CAPABILITIES;
}

export function buildComputerSessionRequest(
    args: Record<string, unknown>,
    config: ComputerToolConfig,
    callId: string
): ComputerSessionRequest {
    const parsedArgs = parseToolArguments(
        COMPUTER_SESSION_TOOL_NAME,
        computerSessionArgsSchema,
        args
    );

    return {
        sessionId: parsedArgs.sessionId ?? `session-${callId}`,
        target: cleanTarget(parsedArgs.target),
        capabilities: parsedArgs.capabilities ?? defaultCapabilities(config),
        providerHints: parsedArgs.providerHints ?? defaultProviderHints(config),
        reason: parsedArgs.reason,
        timeoutMs: config.timeoutMs,
    };
}

export function buildComputerObservationRequest(
    args: Record<string, unknown>,
    config: ComputerToolConfig
): ComputerObservationRequest {
    const parsedArgs = parseToolArguments(
        COMPUTER_OBSERVE_TOOL_NAME,
        computerObserveArgsSchema,
        args
    );

    return {
        sessionId: parsedArgs.sessionId,
        mode: parsedArgs.mode,
        target: cleanTarget(parsedArgs.target),
        include: parsedArgs.include ?? DEFAULT_OBSERVE_INCLUDES,
        reason: parsedArgs.reason,
        timeoutMs: config.timeoutMs,
    };
}

function isNativeElementTarget(target: ComputerTarget): boolean {
    return Boolean(target.elementId || target.windowId || target.element?.id || target.window?.id);
}

export function buildComputerActionRequest(
    args: Record<string, unknown>,
    config: ComputerToolConfig
): ComputerActionRequest {
    const parsedArgs = parseToolArguments(COMPUTER_ACT_TOOL_NAME, computerActArgsSchema, args);
    const target = cleanTarget(parsedArgs.target);
    const executionMode = parsedArgs.executionMode ?? config.defaultExecutionMode;

    if (executionMode === 'background' && !isNativeElementTarget(target)) {
        throw new Error('background execution requires a native elementId or windowId target');
    }

    return {
        sessionId: parsedArgs.sessionId,
        operation: parsedArgs.operation,
        target,
        value: parsedArgs.value ?? null,
        executionMode,
        reason: parsedArgs.reason,
        routeHint: parsedArgs.routeHint ?? 'auto',
        timeoutMs: config.timeoutMs,
        options: {
            allowBackground: executionMode === 'background',
            dryRun: parsedArgs.dryRun ?? false,
            postActionObserve: parsedArgs.postActionObserve ?? false,
        },
    };
}

function warningLines(warnings?: readonly string[]): string[] {
    if (!warnings || warnings.length === 0) {
        return [];
    }

    return [`Warnings: ${warnings.join('; ')}`];
}

export function formatComputerSessionResult(response: ComputerSessionResponse): string {
    const lines = [
        `Computer session ${response.status}: ${response.sessionId}`,
        `Target: ${response.target.label ?? response.target.scope ?? 'unspecified'}`,
        `Lanes: ${response.capabilities.lanes.join(', ') || 'none'}`,
        `Routes: ${response.capabilities.routes.join(', ') || 'none'}`,
        `Background actions: ${response.capabilities.background.supported ? 'supported' : 'unsupported'}`,
        ...warningLines(response.warnings),
    ];

    if (response.status === 'ready') {
        lines[0] = `Computer session ready: ${response.sessionId}`;
    }

    return lines.join('\n');
}

export function formatComputerObservationResult(response: ComputerObservationResponse): string {
    const focusedWindow = response.windows.find((window) => window.focused);
    const lines = [
        `Observation ${response.observationId} for session ${response.sessionId}`,
        `Platform: ${response.platform}`,
        `Target: ${response.target.label ?? response.target.scope ?? 'unspecified'}`,
        `Displays: ${response.displays.length}`,
        `Windows: ${response.windows.length}${focusedWindow ? ` (${focusedWindow.title})` : ''}`,
    ];

    if (response.tree) {
        lines.push(`Tree lane: ${response.tree.lane}; elements: ${response.tree.elements.length}`);
    }

    if (response.screenshot) {
        lines.push(
            `Screenshot: ${response.screenshot.width}x${response.screenshot.height} ${response.screenshot.format}`
        );
    }

    lines.push(...warningLines(response.warnings));
    return lines.join('\n');
}

export function formatComputerActionResult(response: ComputerActionResponse): string {
    const receipt = computerActionReceipt(response);
    const lines = [
        `Computer action ${receipt.status}: ${response.actionId}`,
        JSON.stringify(
            {
                operation: response.operation,
                route: receipt.route,
                lane: receipt.lane,
                backgroundSafe: receipt.backgroundSafe,
                cursorMoved: receipt.cursorMoved,
                foregroundChanged: receipt.foregroundChanged,
                targetResolved: receipt.targetResolved,
                status: receipt.status,
                warnings: receipt.warnings,
            },
            null,
            2
        ),
    ];

    if (response.postActionObservation) {
        const observation = response.postActionObservation;
        lines.push(
            [
                `Post-action observation: ${observation.observationId}`,
                `Windows: ${observation.windows.length}`,
                `Tree elements: ${observation.tree?.elements.length ?? 0}`,
            ].join('\n')
        );
    }

    return lines.join('\n');
}

export function computerActionReceipt(response: ComputerActionResponse): ComputerActionReceipt {
    if ('receipt' in response) {
        return response.receipt;
    }

    return {
        route: response.route,
        lane: response.lane,
        backgroundSafe: response.backgroundSafe,
        cursorMoved: response.cursorMoved,
        foregroundChanged: response.foregroundChanged,
        targetResolved: response.targetResolved,
        status: response.status,
        warnings: response.warnings,
    };
}
