import { inject, type InjectionKey } from 'vue';

import type { ModelAdministration } from '@/modules/models/public';
import { ModelAdministrationError } from '@/modules/models/public';

export type {
    Model,
    ModelAdministration,
    ModelPatch,
    ModelWithProvider,
    NewModel,
    NewProvider,
    Provider,
    ProviderPatch,
} from '@/modules/models/public';
export { ModelAdministrationError } from '@/modules/models/public';
export type { ProviderDriver } from '@touchai/models/contracts';
export const modelAdministrationApiKey: InjectionKey<ModelAdministration> = Symbol(
    'touchai.models.administration'
);
export function useModelAdministrationApi(): ModelAdministration {
    const api = inject(modelAdministrationApiKey);
    if (!api) throw new ModelAdministrationError('MODEL_ADMINISTRATION_UNAVAILABLE');
    return api;
}
