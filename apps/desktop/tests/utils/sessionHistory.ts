import { AiError } from '@/app/api/agent/errors';
import { tt } from '@/i18n';
import { createSessionHistory } from '@/modules/agent';
import { hydratePersistedAttachments } from '@/modules/attachments';
import { log } from '@/platform/diagnostics';

import { agentPresentation } from './agentProjection';

export const buildSessionHistory = createSessionHistory({
    hydrateAttachments: hydratePersistedAttachments,
    tools: agentPresentation,
    messages: {
        tt,
        displayError: AiError.getKnownDefaultDisplayMessage,
        retryText: (attempt, maxRetries) =>
            tt('重试中...({attempt}/{maxRetries})', { attempt, maxRetries }),
    },
    diagnostics: log,
}).build;
