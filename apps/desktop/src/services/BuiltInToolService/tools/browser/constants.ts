import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

export const BROWSER_SESSION_TOOL_ID = 'browser_session';
export const BROWSER_OBSERVE_TOOL_ID = 'browser_observe';
export const BROWSER_ACT_TOOL_ID = 'browser_act';

export const BROWSER_SESSION_OPERATIONS = ['status', 'start', 'stop'] as const;

export const BROWSER_OBSERVE_OPERATIONS = ['current', 'tabs', 'screenshot', 'dom'] as const;

export const BROWSER_ACT_OPERATIONS = [
    'navigate',
    'click',
    'type',
    'fill',
    'fill_form',
    'press_key',
    'scroll',
    'wait',
    'back',
    'forward',
    'reload',
] as const;

const TAB_ID_PROPERTY = {
    type: 'string',
    description: 'Optional browser tab id. Defaults to the selected tab.',
};

const REF_PROPERTY = {
    type: 'string',
    description: 'Stable element ref returned by browser_observe snapshot.',
};

export const BROWSER_SESSION_TOOL_DESCRIPTION = [
    'Manage the native browser automation session.',
    'Use this for managed browser status, launch, and stop.',
    'This tool does not expose raw CDP or JavaScript evaluation.',
].join(' ');

export const BROWSER_OBSERVE_TOOL_DESCRIPTION = [
    'Observe the selected browser tab through the native browser runtime.',
    'Returns compact redacted current-tab state, tab list, screenshots, or DOM-like snapshots.',
    'Screenshot base64 is never returned to the model.',
].join(' ');

export const BROWSER_ACT_TOOL_DESCRIPTION = [
    'Interact with elements in the selected browser tab using refs from browser_observe.',
    'Supports navigation, clicks, typing, form filling, key presses, scrolling, waits, history actions, and reloads.',
    'Use browser_observe after actions to verify page state.',
].join(' ');

export const BROWSER_SESSION_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        operation: {
            type: 'string',
            enum: [...BROWSER_SESSION_OPERATIONS],
            description: 'Browser session operation to perform.',
        },
        browserId: {
            type: 'string',
            description:
                'Optional safe browser id such as chrome or edge for managed browser start.',
        },
        startupUrl: {
            type: 'string',
            description: 'Optional startup URL for the managed browser start operation.',
        },
    },
    required: ['operation'],
    additionalProperties: false,
};

export const BROWSER_OBSERVE_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        operation: {
            type: 'string',
            enum: [...BROWSER_OBSERVE_OPERATIONS],
            description: 'Observation operation to perform.',
        },
        tabId: TAB_ID_PROPERTY,
        includeConsole: {
            type: 'boolean',
            description: 'Include a compact recent console summary for the selected tab.',
        },
        includeNetwork: {
            type: 'boolean',
            description:
                'Include a compact recent failed/error network summary for the selected tab.',
        },
    },
    required: ['operation'],
    additionalProperties: false,
};

export const BROWSER_ACT_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        operation: {
            type: 'string',
            enum: [...BROWSER_ACT_OPERATIONS],
            description: 'Browser action operation to perform.',
        },
        tabId: TAB_ID_PROPERTY,
        ref: REF_PROPERTY,
        navigationToken: {
            type: 'string',
            description:
                'Navigation token returned with observed refs. Required when acting on refs.',
        },
        url: {
            type: 'string',
            description: 'URL for navigate operation.',
        },
        text: {
            type: 'string',
            description: 'Text for type operation.',
        },
        value: {
            type: 'string',
            description: 'Value for fill operation.',
        },
        fields: {
            type: 'array',
            description: 'Fields for fill_form operation.',
            items: {
                type: 'object',
                properties: {
                    ref: REF_PROPERTY,
                    navigationToken: {
                        type: 'string',
                        description: 'Navigation token returned with the field ref.',
                    },
                    value: {
                        type: 'string',
                        description: 'Value to fill into the field.',
                    },
                },
                required: ['ref', 'navigationToken', 'value'],
                additionalProperties: false,
            },
        },
        key: {
            type: 'string',
            description: 'Keyboard key for press_key operation.',
        },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
        timeoutMs: {
            type: 'integer',
            minimum: 100,
            maximum: 120000,
            description: 'Timeout for wait operation.',
        },
    },
    required: ['operation'],
    additionalProperties: false,
};
