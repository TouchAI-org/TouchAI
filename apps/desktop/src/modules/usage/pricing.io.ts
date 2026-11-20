import { findModelPricing } from '@/database/queries/llmMetadata';

export async function readLiveOutputPrice(modelId: string): Promise<number | null> {
    const pricing = await findModelPricing(modelId);
    return pricing ? Number(pricing.outputPerMillion) : null;
}
