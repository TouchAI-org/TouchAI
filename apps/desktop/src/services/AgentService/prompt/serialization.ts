import type { PromptSnapshot } from './types';

/** Skill bodies are request context; only their identity and hash belong in history. */
export function summarizePromptSnapshot(snapshot: PromptSnapshot): PromptSnapshot {
    if (!snapshot.fragments.some((fragment) => fragment.source === 'skill')) {
        return snapshot;
    }
    const fragments = snapshot.fragments.filter((fragment) => fragment.source !== 'skill');
    return {
        ...snapshot,
        fragments,
        systemPrompt: fragments
            .map((fragment) => fragment.content)
            .join('\n\n')
            .trim(),
    };
}

export function serializePromptSnapshot(snapshot: PromptSnapshot): string {
    return JSON.stringify(summarizePromptSnapshot(snapshot));
}
