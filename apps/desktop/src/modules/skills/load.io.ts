import { awaitAbortable } from '@/utils/abort';

import { loadSelectedSkillsFromCatalogWithReader } from './activation';
import { discoverSkills, readEnabledSkillContent } from './catalog.io';
import type { LoadedSkillContext, SelectedSkill, SkillActivationSource } from './contracts';

export async function loadSelectedSkills(
    selected: SelectedSkill[],
    activatedBy: SkillActivationSource = 'user_tag',
    signal?: AbortSignal
): Promise<LoadedSkillContext[]> {
    signal?.throwIfAborted();
    if (selected.length === 0) return [];
    const catalog = await awaitAbortable(discoverSkills, signal);
    signal?.throwIfAborted();
    return loadSelectedSkillsFromCatalogWithReader(
        selected,
        catalog,
        (path) => awaitAbortable(() => readEnabledSkillContent({ path }), signal),
        activatedBy
    );
}
