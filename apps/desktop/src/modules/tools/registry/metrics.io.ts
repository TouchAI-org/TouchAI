import { findAllBuiltInTools } from '@database/queries/builtInTools';
import { findAllMcpTools } from '@database/queries/mcpTools';

/** Consumption sees declaration metrics, not the registry or execution bindings. */
export async function getToolDefinitionMetrics() {
    const [mcp, builtin] = await Promise.all([findAllMcpTools(), findAllBuiltInTools()]);
    return {
        mcp: mcp.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
        })),
        builtin: builtin.map((tool) => ({ tool_id: tool.tool_id, description: tool.description })),
    };
}
