import { buildComputerUsePresentation } from '../builtin/computer-control/presentation';
import type {
    BuiltInTool,
    BuiltInToolConversationPresentation,
    BuiltInToolConversationSemantic,
    BuiltInToolConversationSemanticAction,
    BuiltInToolConversationStatus,
    BuiltInToolId,
} from '../contracts/builtin';
import type { ToolMessages } from '../contracts/host';

/** Derive presentation from the authoritative descriptors; this grants no execution access. */
export function createToolPresentation(input: readonly BuiltInTool[], language: ToolMessages) {
    const descriptors = Object.freeze([...input]);
    const names = new Set<string>();
    for (const descriptor of descriptors) {
        if (names.has(descriptor.id))
            throw new Error(`Duplicate tool name: builtin__${descriptor.id}`);
        names.add(descriptor.id);
    }
    const messages = Object.freeze({
        t: language.t.bind(language),
        tt: language.tt.bind(language),
    });
    const t = messages.t;
    const BUILTIN_TOOL_PREFIX = 'builtin__';
    const BUILTIN_TOOL_VERB_KEYS: Record<
        BuiltInToolConversationSemanticAction,
        Record<'executing' | 'error' | 'completed', string>
    > = {
        process: {
            executing: 'builtInTools.presentation.process.executing',
            error: 'builtInTools.presentation.process.error',
            completed: 'builtInTools.presentation.process.completed',
        },
        run: {
            executing: 'builtInTools.presentation.run.executing',
            error: 'builtInTools.presentation.run.error',
            completed: 'builtInTools.presentation.run.completed',
        },
        search: {
            executing: 'builtInTools.presentation.search.executing',
            error: 'builtInTools.presentation.search.error',
            completed: 'builtInTools.presentation.search.completed',
        },
        read: {
            executing: 'builtInTools.presentation.read.executing',
            error: 'builtInTools.presentation.read.error',
            completed: 'builtInTools.presentation.read.completed',
        },
        review: {
            executing: 'builtInTools.presentation.review.executing',
            error: 'builtInTools.presentation.review.error',
            completed: 'builtInTools.presentation.review.completed',
        },
        update: {
            executing: 'builtInTools.presentation.update.executing',
            error: 'builtInTools.presentation.update.error',
            completed: 'builtInTools.presentation.update.completed',
        },
        switch: {
            executing: 'builtInTools.presentation.switch.executing',
            error: 'builtInTools.presentation.switch.error',
            completed: 'builtInTools.presentation.switch.completed',
        },
        render: {
            executing: 'builtInTools.presentation.render.executing',
            error: 'builtInTools.presentation.render.error',
            completed: 'builtInTools.presentation.render.completed',
        },
        remove: {
            executing: 'builtInTools.presentation.remove.executing',
            error: 'builtInTools.presentation.remove.error',
            completed: 'builtInTools.presentation.remove.completed',
        },
        ask: {
            executing: 'builtInTools.presentation.ask.executing',
            error: 'builtInTools.presentation.ask.error',
            completed: 'builtInTools.presentation.ask.completed',
        },
        cursor: {
            executing: 'builtInTools.presentation.process.executing',
            error: 'builtInTools.presentation.process.error',
            completed: 'builtInTools.presentation.process.completed',
        },
    };

    function normalizeToolId(toolName: string): BuiltInToolId | null {
        const trimmed = toolName.trim();
        if (!trimmed) {
            return null;
        }

        const directId = trimmed.startsWith(BUILTIN_TOOL_PREFIX)
            ? trimmed.slice(BUILTIN_TOOL_PREFIX.length)
            : trimmed;
        const directMatch = descriptors.find((tool) => tool.id === directId);
        if (directMatch) {
            return directMatch.id;
        }

        const normalized = trimmed.toLowerCase().replace(/[\s_-]+/g, '');
        for (const tool of descriptors) {
            const toolId = tool.id.toLowerCase().replace(/[\s_-]+/g, '');
            const displayName = tool.displayName.toLowerCase().replace(/[\s_-]+/g, '');
            if (normalized === toolId || normalized === displayName) {
                return tool.id;
            }
        }

        return null;
    }

    function getBuiltInToolConversationVerb(
        action: BuiltInToolConversationSemanticAction,
        status: BuiltInToolConversationStatus
    ): string {
        if (action === 'cursor') {
            return '⌖';
        }

        if (status === 'awaiting_approval') {
            return t('builtInTools.presentation.pendingApproval');
        }

        if (status === 'rejected') {
            return t('common.rejected');
        }

        if (status === 'cancelled') {
            return t('common.cancelled');
        }

        const key =
            BUILTIN_TOOL_VERB_KEYS[action][
                status === 'executing' || status === 'error' ? status : 'completed'
            ];
        return t(key);
    }

    interface ResolveBuiltInToolConversationSemanticOptions {
        semantic?: BuiltInToolConversationSemantic;
    }

    function buildBuiltInToolConversationPresentationFromSemantic(
        semantic: BuiltInToolConversationSemantic,
        status: BuiltInToolConversationStatus,
        fallbackContent: string
    ): BuiltInToolConversationPresentation {
        return {
            verb: getBuiltInToolConversationVerb(semantic.action, status),
            content: semantic.target?.trim() || fallbackContent,
        };
    }

    function resolveBuiltInToolConversationSemantic(
        toolName: string,
        args: Record<string, unknown>,
        options: ResolveBuiltInToolConversationSemanticOptions = {}
    ): BuiltInToolConversationSemantic | null {
        const toolId = normalizeToolId(toolName);
        if (!toolId) {
            return null;
        }

        const tool = descriptors.find((tool) => tool.id === toolId);
        if (!tool) {
            return null;
        }

        if (options.semantic) {
            return options.semantic;
        }

        return tool.buildConversationSemantic(args);
    }

    function buildBuiltInToolConversationPresentation(
        toolName: string,
        args: Record<string, unknown>,
        status: BuiltInToolConversationStatus,
        options: ResolveBuiltInToolConversationSemanticOptions = {}
    ): BuiltInToolConversationPresentation | null {
        const toolId = normalizeToolId(toolName);
        if (!toolId) {
            return null;
        }

        const tool = descriptors.find((tool) => tool.id === toolId);
        if (!tool) {
            return null;
        }

        if (toolId === 'computer_use') {
            return buildComputerUsePresentation(args, status, messages);
        }

        const semantic = resolveBuiltInToolConversationSemantic(toolName, args, options);
        if (!semantic) {
            return null;
        }

        return buildBuiltInToolConversationPresentationFromSemantic(
            semantic,
            status,
            tool.displayName
        );
    }

    return Object.freeze({
        resolveSemantic: resolveBuiltInToolConversationSemantic,
        presentation: buildBuiltInToolConversationPresentation,
        widgetToolName: 'builtin__show_widget',
    });
}
