import type { PromptFragment, PromptSource } from '../contracts/agent';

const ORDER: readonly PromptSource[] = [
    'override',
    'platform',
    'policy',
    'agent_profile',
    'session_memory',
    'mode',
    'feature',
    'skill',
    'user_append',
];

export function assemblePrompt(fragments: readonly PromptFragment[]): string {
    return ORDER.flatMap((source) => fragments.filter((fragment) => fragment.source === source))
        .map((fragment) => fragment.content.trim())
        .filter(Boolean)
        .join('\n\n')
        .trim();
}
