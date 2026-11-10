import type { PromptSnapshot } from '../prompt/types';
import { getBuiltInSkills } from './builtin';
import { normalizeSkillPath } from './path';

const KEY_PLACEHOLDER = '{{WIDGET_SKILL_KEY}}';

export function publicWidgetArguments(args: Record<string, unknown>): Record<string, unknown> {
    const visible = { ...args };
    delete visible.skill_key;
    return visible;
}

/** One read receipt per logical request. Never included in public task state. */
export class WidgetSkillAccess {
    #key: string | undefined;

    activate(content: string): string {
        if (!content.includes(KEY_PLACEHOLDER)) {
            throw new Error('The built-in widget skill is missing its read credential');
        }
        this.#key ??= crypto.randomUUID();
        return content.replace(KEY_PLACEHOLDER, this.#key);
    }

    async prepareSnapshot(snapshot: PromptSnapshot): Promise<PromptSnapshot> {
        if (!snapshot.skills?.length) return snapshot;
        const widget = (await getBuiltInSkills()).find((skill) => skill.name === 'widget');
        const selected =
            widget &&
            snapshot.skills.find(
                (skill) => normalizeSkillPath(skill.path) === normalizeSkillPath(widget.path)
            );
        if (!selected) return snapshot;
        const fragments = snapshot.fragments.map((fragment) =>
            fragment.source === 'skill' &&
            fragment.content.includes(`<path>${selected.path}</path>`)
                ? { ...fragment, content: this.activate(fragment.content) }
                : fragment
        );
        return {
            ...snapshot,
            fragments,
            systemPrompt: fragments
                .map((fragment) => fragment.content)
                .join('\n\n')
                .trim(),
        };
    }

    isAuthorized(value: unknown): boolean {
        return this.#key !== undefined && typeof value === 'string' && value === this.#key;
    }

    clear(): void {
        this.#key = undefined;
    }
}
