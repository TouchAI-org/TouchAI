import type { ModelDropdownItem } from '../types';

export function filterModelDropdownItems(models: ModelDropdownItem[], searchQuery: string) {
    const query = searchQuery.toLowerCase().trim();
    if (!query) {
        return models;
    }

    const tokens = query.split(/\s+/).filter(Boolean);
    const scored = models
        .map((model) => {
            const fields = [
                model.name.toLowerCase(),
                model.modelId.toLowerCase(),
                model.providerName.toLowerCase(),
                `${model.providerName} ${model.modelId}`.toLowerCase(),
            ];

            let totalScore = 0;
            for (const token of tokens) {
                let bestScore = -1;
                for (const field of fields) {
                    const score = scoreModelDropdownMatch(token, field);
                    if (score > bestScore) {
                        bestScore = score;
                    }
                }

                if (bestScore < 0) {
                    return null;
                }

                totalScore += bestScore;
            }

            return {
                model,
                score: totalScore,
            };
        })
        .filter(Boolean) as Array<{ model: ModelDropdownItem; score: number }>;

    return scored.sort((left, right) => right.score - left.score).map((item) => item.model);
}

function scoreModelDropdownMatch(token: string, text: string) {
    if (!token) {
        return -1;
    }

    const index = text.indexOf(token);
    if (index !== -1) {
        return 200 - index;
    }

    if (isModelDropdownSubsequence(token, text)) {
        return 100;
    }

    return -1;
}

function isModelDropdownSubsequence(needle: string, haystack: string) {
    let currentIndex = 0;
    for (const char of haystack) {
        if (char === needle[currentIndex]) {
            currentIndex += 1;
            if (currentIndex >= needle.length) {
                return true;
            }
        }
    }

    return false;
}
