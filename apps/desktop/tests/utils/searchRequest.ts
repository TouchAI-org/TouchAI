import {
    createAgentWindowFixture,
    network,
    response,
    streamingResponse,
} from '@tests/utils/agentWindow';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, expect } from 'vitest';
import { ref } from 'vue';

import { agentApiKey } from '@/app/api/agent';
import { createInputHistorySnapshot } from '@/app/api/agent/history';
import { useSearchRequestFlow } from '@/views/SearchView/composables/useSearchRequest';
import type { SearchModelOverride } from '@/views/SearchView/types';

export { network, response, streamingResponse };
let fixture: ReturnType<typeof createAgentWindowFixture>;
const unmounts: (() => void)[] = [];
beforeEach(async () => {
    fixture = createAgentWindowFixture();
    await fixture.window.ready;
    fixture.database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id) VALUES
        (7, 'history-seven', 'Alpha project', 'fixture-model', 1),
        (8, 'history-eight', 'Beta project', 'fixture-model', 1);`);
});
afterEach(async () => {
    for (const unmount of unmounts.splice(0)) unmount();
    await fixture.window.dispose();
});
export function searchRequestFixture() {
    return fixture;
}
export async function mountSearchFlow(
    options: { unsupported?: string; model?: SearchModelOverride } = {}
) {
    let draftClears = 0;
    const modelOverride = ref(options.model ?? { modelId: null, providerId: null });
    const view = await mountComposable(
        () =>
            useSearchRequestFlow({
                modelOverride,
                clearDraft: () => {
                    draftClears++;
                },
                getSupportedAttachments: () => [],
                getUnsupportedAttachmentMessage: () => options.unsupported ?? null,
                getCurrentInputSnapshot: (text) => createInputHistorySnapshot({ text }),
            }),
        (app) => app.provide(agentApiKey, fixture.window.api)
    );
    unmounts.push(view.unmount);
    return { ...view, modelOverride, cleared: () => draftClears };
}
export async function finishSearch(
    channel: ReturnType<typeof streamingResponse>,
    answer = 'Completed answer'
) {
    channel.delta({ role: 'assistant', content: answer });
    channel.finish();
    await expect.poll(() => searchRequestFixture().window.api.listActiveTasks().length).toBe(0);
}
