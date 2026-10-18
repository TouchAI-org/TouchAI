/**
 * 一次性回填：给已提交的 bundled snapshot 补上 `cost` 字段。
 *
 * 为什么单独写一个脚本，而不是重跑 `update-model-metadata.mjs`：
 * 重跑会用当前上游数据整份替换模型集合，产生上万行与本次改动无关的
 * 差异（上游增删模型），让 review 无法聚焦，也会让既有快照测试失效。
 *
 * 这里只做一件事：按 `provider/modelId` → 模型 `id` → `modelId` 末段
 * 三种键去上游查价，命中就写入 `cost`，模型集合与顺序完全不变。
 *
 * 用法：node scripts/backfill-snapshot-cost.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.resolve(
    scriptDirectory,
    '../src/services/AgentService/infrastructure/modelMetadata/snapshot.json'
);

const response = await fetch('https://models.dev/api.json');
if (!response.ok) {
    throw new Error(`Failed to fetch the upstream catalog: ${response.status}`);
}

const upstream = await response.json();
const byProviderModelId = new Map();
const byModelId = new Map();

for (const [providerId, provider] of Object.entries(upstream)) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        byProviderModelId.set(`${providerId}/${modelId}`, model);
        if (!byModelId.has(model.id)) {
            byModelId.set(model.id, model);
        }
        if (!byModelId.has(modelId)) {
            byModelId.set(modelId, model);
        }
    }
}

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));

let alreadyPriced = 0;
let filled = 0;
let stillUnpriced = 0;

for (const [key, record] of Object.entries(snapshot.models)) {
    if (record.cost) {
        alreadyPriced += 1;
        continue;
    }

    const match =
        byProviderModelId.get(key) ??
        byModelId.get(record.id) ??
        byModelId.get(key.split('/').pop() ?? '');

    if (match?.cost) {
        record.cost = match.cost;
        filled += 1;
    } else {
        stillUnpriced += 1;
    }
}

writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

console.log(
    `snapshot cost backfill: filled=${filled} already=${alreadyPriced} unpriced=${stillUnpriced}`
);
