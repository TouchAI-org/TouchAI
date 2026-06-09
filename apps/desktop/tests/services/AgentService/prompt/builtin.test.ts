import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/AgentService/prompt/memoryDirectory', () => ({
    buildMemoryDirectoryPrompt: vi.fn(),
}));

const { buildMemoryDirectoryPrompt } =
    await import('@/services/AgentService/prompt/memoryDirectory');
const {
    buildBuiltInPromptContext,
    buildTouchAiBuiltinSystemPrompt,
    resolveBuiltInPromptToolAvailability,
} = await import('@/services/AgentService/prompt/builtin');

describe('built-in system prompt tool gating', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('omits memory and conversation search instructions when those tools are unavailable', async () => {
        vi.mocked(buildMemoryDirectoryPrompt).mockResolvedValue(['unused']);

        const availability = resolveBuiltInPromptToolAvailability(undefined);
        const prompt = buildTouchAiBuiltinSystemPrompt(availability);
        const context = await buildBuiltInPromptContext(undefined);

        expect(availability).toEqual({
            hasMemoryTool: false,
            hasSearchConversationTool: false,
        });
        expect(prompt).not.toContain('builtin__memory');
        expect(prompt).not.toContain('builtin__search_conversation');
        expect(context.sessionMemory).toEqual([]);
        expect(buildMemoryDirectoryPrompt).not.toHaveBeenCalled();
    });

    it('includes only memory instructions and directory context when the memory tool is available', async () => {
        vi.mocked(buildMemoryDirectoryPrompt).mockResolvedValue(['memory directory']);

        const toolDefinitions = [{ name: 'builtin__memory' }];
        const availability = resolveBuiltInPromptToolAvailability(toolDefinitions);
        const prompt = buildTouchAiBuiltinSystemPrompt(availability);
        const context = await buildBuiltInPromptContext(toolDefinitions);

        expect(availability).toEqual({
            hasMemoryTool: true,
            hasSearchConversationTool: false,
        });
        expect(prompt).toContain('builtin__memory');
        expect(prompt).not.toContain('builtin__search_conversation');
        expect(context.sessionMemory).toEqual(['memory directory']);
        expect(buildMemoryDirectoryPrompt).toHaveBeenCalledTimes(1);
    });

    it('includes conversation search instructions only when that tool is available', () => {
        const availability = resolveBuiltInPromptToolAvailability([
            { name: 'builtin__search_conversation' },
        ]);
        const prompt = buildTouchAiBuiltinSystemPrompt(availability);

        expect(availability).toEqual({
            hasMemoryTool: false,
            hasSearchConversationTool: true,
        });
        expect(prompt).not.toContain('builtin__memory');
        expect(prompt).toContain('builtin__search_conversation');
    });
});
