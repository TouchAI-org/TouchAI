import type { ToolEvent, ToolInvocationScope } from '@/modules/tools';
import { createToolAudit } from '@/modules/tools';

import { createToolsHostFixture } from './toolsHost';

export async function createAuditedToolsFixture() {
    const input = await createToolsHostFixture();
    input.database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (7, 'tool-history-fixture', 'Tool request', 'model-a', 1);
        INSERT INTO messages (id, session_id, role) VALUES (8, 7, 'tool_call');`);
    const events: ToolEvent[] = [];
    const controller = new AbortController();
    const audit = createToolAudit({ taskId: input.taskId, isCurrent: () => true });
    const scope: ToolInvocationScope = {
        iteration: 1,
        signal: controller.signal,
        task: {
            taskId: input.taskId,
            attemptToken: 'first-attempt',
            attemptGeneration: 1,
            signal: controller.signal,
            stop: () => controller.abort(),
            currentModel: input.currentModel,
            historyTarget: { sessionId: 7, messageId: 8 },
            ask: async () => null,
            present: (event) => events.push(event),
        },
    };
    return {
        ...input,
        controller,
        events,
        scope,
        snapshot: () =>
            input.host.tools.snapshot({
                beginAudit: audit.begin,
                preparation: { taskId: input.taskId, currentModel: input.currentModel },
            }),
        saved() {
            return input.database
                .prepare("SELECT data FROM message_parts WHERE type = 'tool_call' ORDER BY id")
                .all()
                .map((row) => JSON.parse(String(row.data)) as Record<string, unknown>);
        },
    };
}
