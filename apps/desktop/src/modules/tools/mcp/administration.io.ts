import { z } from 'zod';

import {
    createMcpServer,
    deleteMcpServer,
    findAllMcpServers,
    updateMcpServer,
} from '@/database/queries/mcpServers';
import {
    findMcpToolLogById,
    findMcpToolLogSummariesByServerId,
} from '@/database/queries/mcpToolLogs';
import { findMcpToolsByServerId, updateMcpTool } from '@/database/queries/mcpTools';

import type { McpAdministration, McpCatalog } from '../contracts/mcpAdministration';
import { mcpServerDraftSchema } from '../contracts/mcpAdministration';

export function createMcpCatalog(): McpCatalog {
    return Object.freeze({
        listServers: async () =>
            (await findAllMcpServers()).map(({ id, name, enabled, version }) => ({
                id,
                name,
                enabled,
                version,
            })),
        listTools: findMcpToolsByServerId,
    });
}

export function createMcpAdministration(): McpAdministration {
    return Object.freeze<McpAdministration>({
        findAllMcpServers,
        createMcpServer: (data) => createMcpServer(mcpServerDraftSchema.parse(data)),
        updateMcpServer: (id, data) =>
            updateMcpServer(id, mcpServerDraftSchema.partial().parse(data)),
        deleteMcpServer,
        findMcpToolsByServerId,
        updateMcpTool: (id, patch) =>
            updateMcpTool(
                id,
                z
                    .strictObject({ enabled: z.union([z.literal(0), z.literal(1)]).optional() })
                    .parse(patch)
            ),
        findMcpToolLogSummariesByServerId,
        findMcpToolLogById,
    });
}
