import type { PromptInputSnapshot, PromptSnapshot } from './types';

export function createPromptInputSnapshot(
    input?: PromptInputSnapshot
): PromptInputSnapshot | undefined {
    const snapshot: PromptInputSnapshot = {
        ...(input?.skills?.length
            ? { skills: input.skills.map((skill) => ({ name: skill.name, path: skill.path })) }
            : {}),
        ...(input?.editorDoc ? { editorDoc: input.editorDoc } : {}),
        ...(input?.excludeFromHistory ? { excludeFromHistory: true } : {}),
    };
    return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

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
