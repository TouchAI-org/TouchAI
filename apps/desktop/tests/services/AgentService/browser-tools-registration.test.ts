import { describe, expect, it } from 'vitest';

import { builtInToolRegistry } from '@/services/BuiltInToolService/registry';

describe('browser built-in tool registration', () => {
    it('registers exactly three model-visible browser tools', () => {
        const browserToolIds = builtInToolRegistry
            .list()
            .map((tool) => tool.id)
            .filter((id) => id.startsWith('browser_'))
            .sort();

        expect(browserToolIds).toEqual(['browser_act', 'browser_observe', 'browser_session']);
    });

    it('does not register raw browser implementation tools', () => {
        const registeredIds = builtInToolRegistry.list().map((tool) => tool.id);

        expect(registeredIds).not.toContain('browser_cdp');
        expect(registeredIds).not.toContain('browser_debug');
        expect(registeredIds).not.toContain('browser_extract');
        expect(registeredIds).not.toContain('browser_evaluate');
    });
});
