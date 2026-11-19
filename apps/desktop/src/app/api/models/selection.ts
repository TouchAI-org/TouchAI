import { createWindowEvent } from '@/platform/windows/events';

export type { ModelOption, ModelReference } from '@/modules/models/public';
export { findModelOption, getActiveModel, listModelOptions } from '@/modules/models/public';

export const MODEL_OPTIONS_UPDATED_EVENT = 'ai-models:updated';
const changed = createWindowEvent<{ sourceId?: string; updatedAt: number }>(
    MODEL_OPTIONS_UPDATED_EVENT
);
export const onModelOptionsChanged = changed.on;
export const publishModelOptionsChanged = changed.emit;
