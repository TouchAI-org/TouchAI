import type { ModelWithProvider } from '@database/queries/models';
import {
    findDefaultModelWithProvider,
    findModelByProviderAndModelId,
    findModelsWithProvider,
} from '@database/queries/models';

import type { ModelOption, ModelReference } from './display';

function display(model: ModelWithProvider): ModelOption {
    return {
        id: model.id,
        created_at: model.created_at,
        updated_at: model.updated_at,
        provider_id: model.provider_id,
        model_id: model.model_id,
        name: model.name,
        is_default: model.is_default,
        last_used_at: model.last_used_at,
        attachment: model.attachment,
        modalities: model.modalities,
        open_weights: model.open_weights,
        reasoning: model.reasoning,
        reasoning_options: model.reasoning_options,
        release_date: model.release_date,
        temperature: model.temperature,
        tool_call: model.tool_call,
        knowledge: model.knowledge,
        context_limit: model.context_limit,
        output_limit: model.output_limit,
        is_custom_metadata: model.is_custom_metadata,
        upstream_metadata: model.upstream_metadata,
        provider_name: model.provider_name,
        provider_driver: model.provider_driver,
        provider_enabled: model.provider_enabled,
        provider_logo: model.provider_logo,
    };
}

export async function getActiveModel(): Promise<ModelOption | null> {
    const model = await findDefaultModelWithProvider();
    return model ? display(model) : null;
}

export async function listModelOptions(
    options: { providerId?: number } = {}
): Promise<ModelOption[]> {
    return (await findModelsWithProvider(options)).map(display);
}

export async function findModelOption(reference: ModelReference): Promise<ModelOption | null> {
    const model = await findModelByProviderAndModelId(reference);
    return model ? display(model) : null;
}
