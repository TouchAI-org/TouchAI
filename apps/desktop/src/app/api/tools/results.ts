import { t } from '@/i18n';
import {
    buildComputerUsePresentation as build,
    type BuiltInToolConversationStatus,
} from '@/modules/tools/public';

export type {
    ParsedBashToolResult,
    WebSearchSource,
    WebSearchSourcesPayload,
} from '@/modules/tools/public';
export {
    isEmptyBashOutputText,
    parseBashToolResult,
    webSearchHostname,
    webSearchSiteName,
} from '@/modules/tools/public';

export function buildComputerUsePresentation(
    args: Record<string, unknown>,
    status: BuiltInToolConversationStatus
) {
    return build(args, status, { t: (key, values) => t(key as Parameters<typeof t>[0], values) });
}
