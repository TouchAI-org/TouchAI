import { createAttachment } from '@/modules/attachments';
import { createReadOperations } from '@/modules/tools';

import { toolMessages } from './toolMessages';

export function createReadToolsFixture() {
    return createReadOperations({
        messages: toolMessages,
        attachments: { create: createAttachment },
    });
}
