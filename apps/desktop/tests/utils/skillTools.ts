import { discoverSkills, loadSelectedSkills } from '@/modules/skills';
import { createActivateSkillTools } from '@/modules/tools';

import { toolMessages } from './toolMessages';

export function createSkillToolsFixture() {
    const tool = createActivateSkillTools({
        messages: toolMessages,
        skills: { discover: discoverSkills, load: loadSelectedSkills },
    })[0]!;
    const prepared = () => tool.prepareForTurn(tool.defaultConfig);
    return {
        buildConversationSemantic: tool.buildConversationSemantic.bind(tool),
        buildApprovalRequest: tool.buildApprovalRequest.bind(tool),
        async buildToolDefinition(name: string) {
            const ready = await prepared();
            return ready.buildToolDefinition(name, ready.defaultConfig);
        },
        async execute(...args: Parameters<typeof tool.execute>) {
            return (await prepared()).execute(...args);
        },
    };
}
