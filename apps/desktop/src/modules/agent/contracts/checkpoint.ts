import type { CheckpointMessage } from './persistence';

export interface CheckpointBoundary {
    activeModel: { id: number };
    iteration: number;
    modelSwitchCount: number;
    modelLanguageContext: { locale: 'zh-CN' | 'en-US'; label: string };
    executedBuiltInToolIds: readonly string[];
    response: string;
    reasoning: string;
    outputParts: readonly { type: 'text' | 'reasoning'; content: string }[];
}

export interface PersistenceCheckpoint extends CheckpointBoundary {
    messages: CheckpointMessage[];
}

/** This is the shipped checkpoint boundary, not a Core-state serializer. */
export function serializeCheckpointBoundary(checkpoint: CheckpointBoundary): string {
    return JSON.stringify({
        activeModelId: checkpoint.activeModel.id,
        iteration: checkpoint.iteration,
        modelSwitchCount: checkpoint.modelSwitchCount,
        modelLanguageContext: checkpoint.modelLanguageContext,
        executedBuiltInToolIds: checkpoint.executedBuiltInToolIds,
        outputBoundary: {
            textLength: checkpoint.response.length,
            reasoningLength: checkpoint.reasoning.length,
            partCount: checkpoint.outputParts.length,
        },
    });
}
