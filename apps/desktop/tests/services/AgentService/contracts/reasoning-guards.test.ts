/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { describe, expect, it } from 'vitest';

import {
    budgetForReasoningLevel,
    clampBudgetToResponseRoom,
    clampReasoningLevel,
    DEFAULT_REASONING_TOKEN_BUDGETS,
    deriveReasoningLevelMap,
    getSupportedReasoningLevels,
    hasReasoningCapability,
    isReasoningLevel,
    isReasoningMode,
    isReasoningProtocol,
    MIN_RESPONSE_TOKENS,
    normalizeReasoningOptions,
    parseReasoningOptions,
    serializeReasoningOptions,
} from '@/services/AgentService/contracts/reasoning';

/**
 * These are the guards the settings page and the request layer rely on when they read
 * upstream metadata, which is frequently dirty. A wrong answer here either hides a level
 * the model supports or sends a parameter the provider rejects.
 */
describe('user reads reasoning capabilities from upstream metadata', () => {
    it('user sees a declared reasoning level accepted and an unknown one rejected', () => {
        expect(isReasoningLevel('high')).toBe(true);
        expect(isReasoningLevel('off')).toBe(false);
        expect(isReasoningLevel('none')).toBe(false);
        expect(isReasoningLevel(42)).toBe(false);
        expect(isReasoningLevel(null)).toBe(false);
    });

    it('user sees a known encoding protocol accepted and an unknown one rejected', () => {
        expect(isReasoningProtocol('openai-responses')).toBe(true);
        expect(isReasoningProtocol('anthropic-messages')).toBe(true);
        expect(isReasoningProtocol('made-up')).toBe(false);
        expect(isReasoningProtocol(undefined)).toBe(false);
    });

    it('user sees a known fallback mode accepted and an unknown one rejected', () => {
        expect(isReasoningMode('auto')).toBe(true);
        expect(isReasoningMode('passthrough')).toBe(true);
        expect(isReasoningMode('off')).toBe(true);
        expect(isReasoningMode('sometimes')).toBe(false);
        expect(isReasoningMode(null)).toBe(false);
    });

    it('user sees a model with no declared options reported as having no reasoning', () => {
        expect(hasReasoningCapability([])).toBe(false);
        expect(hasReasoningCapability(null)).toBe(false);
        expect(hasReasoningCapability(undefined)).toBe(false);
        expect(hasReasoningCapability([{ type: 'toggle' }])).toBe(true);
    });
});

describe('user opens a model whose stored reasoning options are damaged', () => {
    it('user gets no levels offered when nothing was stored', () => {
        expect(parseReasoningOptions(null)).toEqual([]);
        expect(parseReasoningOptions(undefined)).toEqual([]);
        expect(parseReasoningOptions('')).toEqual([]);
    });

    it('user gets no levels offered when the stored options are unreadable', () => {
        expect(parseReasoningOptions('{oops')).toEqual([]);
    });

    it('user gets the stored levels back when they are valid', () => {
        expect(parseReasoningOptions('[{"type":"toggle"}]')).toEqual([{ type: 'toggle' }]);
    });

    it('user gets no levels stored when the model declares none', () => {
        expect(serializeReasoningOptions([])).toBeNull();
        expect(serializeReasoningOptions(null)).toBeNull();
        expect(serializeReasoningOptions(undefined)).toBeNull();
    });

    it('user gets only the well-formed entries kept from a mixed list', () => {
        expect(
            normalizeReasoningOptions([null, { type: 'toggle' }, { type: 'effort', values: [] }])
        ).toEqual([{ type: 'toggle' }]);
    });
});

describe('user sees which thinking levels a model offers', () => {
    it('user gets only the off switch for a model that cannot think', () => {
        expect(getSupportedReasoningLevels({}, false)).toEqual(['off']);
    });

    it('user gets no levels when the model declares nothing at all', () => {
        expect(deriveReasoningLevelMap(undefined)).toEqual({});
        expect(deriveReasoningLevelMap([])).toEqual({});
    });

    it('user gets every level offered for a model that only toggles thinking', () => {
        const map = deriveReasoningLevelMap([{ type: 'toggle' }]);

        expect(map.high).toBe('high');
        expect(map.max).toBe('max');
    });

    it('user gets every level offered for a model that only takes a token budget', () => {
        const map = deriveReasoningLevelMap([{ type: 'budget_tokens', min: 1024 }]);

        expect(map.minimal).toBe('minimal');
        expect(map.ultra).toBe('ultra');
    });

    it('user gets every level marked unavailable when the declared effort list is empty', () => {
        // An effort entry with no values declares the shape but offers nothing.
        const map = deriveReasoningLevelMap([{ type: 'effort', values: [] }]);

        expect(map.off).toBeNull();
        expect(map.minimal).toBeNull();
        expect(map.high).toBeNull();
    });

    it('user gets the strongest levels hidden when the model does not map them', () => {
        const levels = getSupportedReasoningLevels({ high: 'high' });

        // xhigh/max/ultra must be mapped explicitly to be offered.
        expect(levels).toContain('high');
        expect(levels).not.toContain('max');
    });
});

describe('user asks for a thinking level the model does not offer', () => {
    it('user gets the requested level when the model supports it', () => {
        expect(clampReasoningLevel({ max: 'max' }, 'max')).toBe('max');
    });

    it('user gets the nearest weaker level when the requested one is unsupported', () => {
        // max is not mapped, so the request falls back to the strongest level that is.
        const level = clampReasoningLevel({ low: 'low', medium: 'medium' }, 'max');

        expect(level).toBe('high');
    });

    it('user gets a stronger level when the requested one sits below the model ceiling', () => {
        // Only ultra is mapped: max is unavailable, so the request moves up to ultra.
        const level = clampReasoningLevel({ ultra: 'ultra' }, 'max');

        expect(level).toBe('ultra');
    });

    it('user gets the request honored when the model declares no map at all', () => {
        // With no metadata the app trusts the model and sends what the user picked.
        expect(clampReasoningLevel(null, 'high')).toBe('high');
        expect(clampReasoningLevel(undefined, 'medium')).toBe('medium');
    });

    it('user gets the weakest level when a bogus stored level cannot be matched', () => {
        // A stale level name in the database must not be sent to the provider.
        const level = clampReasoningLevel({ low: 'low' }, 'bogus' as never);

        expect(level).toBe('off');
    });
});

describe('user sees the thinking budget for the level they picked', () => {
    it('user gets no budget spent when thinking is off', () => {
        expect(budgetForReasoningLevel('off')).toBe(0);
    });

    it('user gets the high budget for the levels above high', () => {
        expect(budgetForReasoningLevel('xhigh')).toBe(DEFAULT_REASONING_TOKEN_BUDGETS.high);
        expect(budgetForReasoningLevel('max')).toBe(DEFAULT_REASONING_TOKEN_BUDGETS.high);
        expect(budgetForReasoningLevel('ultra')).toBe(DEFAULT_REASONING_TOKEN_BUDGETS.high);
    });

    it('user gets the default budget for a level they did not override', () => {
        expect(budgetForReasoningLevel('medium')).toBe(DEFAULT_REASONING_TOKEN_BUDGETS.medium);
    });

    it('user gets their own budget when the model overrides the default', () => {
        expect(budgetForReasoningLevel('low', { low: 999 })).toBe(999);
    });
});

describe('user has a small context window to answer in', () => {
    it('user gets the full budget when the model states no ceiling', () => {
        expect(clampBudgetToResponseRoom(4000)).toBe(4000);
        expect(clampBudgetToResponseRoom(4000, Number.POSITIVE_INFINITY)).toBe(4000);
    });

    it('user gets the budget cut so the answer still has room', () => {
        const ceiling = MIN_RESPONSE_TOKENS + 1000;

        expect(clampBudgetToResponseRoom(4000, ceiling)).toBe(1000);
    });

    it('user gets no negative budget when the ceiling cannot fit an answer', () => {
        expect(clampBudgetToResponseRoom(4000, 100)).toBe(0);
    });
});
