import { findAllMcpServers } from '@database/queries/mcpServers';

/** History only needs names, never connection configuration or an execution registry. */
export async function readMcpServerNames(): Promise<readonly { id: number; name: string }[]> {
    return (await findAllMcpServers()).map(({ id, name }) => ({ id, name }));
}
