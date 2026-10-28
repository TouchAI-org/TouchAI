/**
 * Asks the model for a scene plan and refuses anything that does not validate.
 *
 * Runs trusted code only: it reads the diff through the API, never checks the
 * pull request out, and the model key never reaches a job that runs pull-request
 * code.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createClient } from './lib/github.mjs';
import { buildPrompt, requestPlan, selectUiDiff } from './lib/model.mjs';
import { defaultPlan, validatePlan } from './lib/scenarios.mjs';

function env(name, fallback = '') {
    return process.env[name] ?? fallback;
}

async function requestValidatedPlan({ baseUrl, apiKey, model, prompt, facts }) {
    let lastErrors = [];
    let nextPrompt = prompt;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const response = await requestPlan({
            baseUrl,
            apiKey,
            model,
            prompt: nextPrompt,
        });

        if (!response.ok) {
            return { plan: null, errors: response.errors };
        }

        const validation = validatePlan(response.plan, {
            testIds: facts.testIds,
            surfaces: ['search', 'settings'],
        });

        if (validation.ok) {
            return { plan: { ...validation.plan, source: 'model' }, errors: [] };
        }

        lastErrors = validation.errors;
        nextPrompt = `${prompt}

The previous plan was rejected by the validator:
${validation.errors.slice(0, 10).join('\n')}

Previous plan:
${JSON.stringify(response.plan).slice(0, 4000)}

Return a corrected JSON object only.`;
    }

    return { plan: null, errors: lastErrors };
}

async function main() {
    const outDir = path.resolve(env('UI_PREVIEW_OUT', 'ui-preview-out'));
    const factsPath = path.join(outDir, 'facts.json');

    if (!fs.existsSync(factsPath)) {
        throw new Error('facts.json is missing; the explore job did not finish');
    }

    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    const [owner, repo] = String(env('GITHUB_REPOSITORY')).split('/');
    const token = env('GH_TOKEN');
    const pr = Number(env('UI_PREVIEW_PR'));
    const client = createClient({ token, owner, repo });
    const pull = await client.getPullRequest(pr);
    const diff = await client.getDiff(pr);
    const uiDiff = selectUiDiff(diff);

    const prompt = buildPrompt({
        title: pull.title,
        body: pull.body,
        files: facts.files,
        diff: uiDiff.text,
        diffFiles: uiDiff.files,
        diffDropped: uiDiff.dropped,
        outline: facts,
    });

    let plan = null;
    const warnings = [];

    const manual = env('UI_PREVIEW_PLAN_JSON');

    if (manual) {
        try {
            const parsed = JSON.parse(manual);
            const validation = validatePlan(parsed, {
                testIds: facts.testIds,
                surfaces: ['search', 'settings'],
            });

            if (validation.ok) {
                plan = { ...validation.plan, source: 'manual' };
            } else {
                warnings.push(
                    `the supplied plan was rejected: ${validation.errors.slice(0, 5).join('; ')}`
                );
            }
        } catch (error) {
            warnings.push(`the supplied plan is not JSON: ${error.message}`);
        }
    }

    if (!plan && env('UI_PREVIEW_MODEL_API_KEY') && env('UI_PREVIEW_MODEL')) {
        const response = await requestValidatedPlan({
            baseUrl: env('UI_PREVIEW_MODEL_BASE_URL', 'https://qai.qianc.top/v1'),
            apiKey: env('UI_PREVIEW_MODEL_API_KEY'),
            model: env('UI_PREVIEW_MODEL'),
            prompt,
            facts,
        });

        if (!response.plan) {
            warnings.push(
                `the model did not return a valid plan: ${response.errors.slice(0, 5).join('; ')}`
            );
        } else {
            plan = response.plan;
        }
    } else if (!plan) {
        warnings.push('no model is configured; the default scene was used');
    }

    if (!plan) {
        plan = defaultPlan({
            touchedSettings: facts.files.some((file) =>
                file.startsWith('apps/desktop/src/views/SettingsView/')
            ),
            touchedSearch: facts.files.some((file) =>
                file.startsWith('apps/desktop/src/views/SearchView/')
            ),
            testIds: facts.testIds,
        });
    }

    if (warnings.length > 0) {
        plan.warnings = warnings;
        console.log(`plan warnings: ${warnings.join(' | ')}`);
    }

    fs.writeFileSync(path.join(outDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`plan: ${plan.scenes.length} scene(s) from ${plan.source}`);
}

main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
});
