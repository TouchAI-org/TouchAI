import { agentApiKey } from '@/app/api/agent';
import { productAnalyticsApiKey } from '@/app/api/analytics/product';
import { clipboardDraftApiKey } from '@/app/api/attachments/drafts';
import { modelDiscoveryApiKey } from '@/app/api/models/discovery';
import { modelMetadataApiKey } from '@/app/api/models/metadata';
import { privacyApiKey } from '@/app/api/privacy';
import { searchApiKey } from '@/app/api/search/queries';
import { startupNoticesApiKey } from '@/app/api/search/startup';
import { settingsApiKey } from '@/app/api/settings/preferences';
import { mcpApiKey } from '@/app/api/tools/mcp';
import { mainToolsStartupApiKey } from '@/app/api/tools/startup';
import type { initializeAgentWindow } from '@/app/bootstrap/agent';
import { initializeSearchWindow } from '@/app/bootstrap/search';

/** Mount the main view with the same bounded clients installed by production bootstrap. */
export function createMainViewClients(window: ReturnType<typeof initializeAgentWindow>) {
    const search = initializeSearchWindow('main');
    return {
        provide: {
            [agentApiKey as symbol]: window.api,
            [productAnalyticsApiKey as symbol]: window.productAnalytics,
            [settingsApiKey as symbol]: window.settings,
            [privacyApiKey as symbol]: window.privacy,
            [modelDiscoveryApiKey as symbol]: window.models,
            [modelMetadataApiKey as symbol]: window.metadata,
            [mcpApiKey as symbol]: window.mcp,
            [mainToolsStartupApiKey as symbol]: { autoConnectMcp: window.autoConnectMcp },
            [startupNoticesApiKey as symbol]: window.startup!,
            [searchApiKey as symbol]: search.api!,
            [clipboardDraftApiKey as symbol]: search.clipboard!,
        },
        dispose: search.dispose,
    };
}
