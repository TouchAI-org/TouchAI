/**
 * Preflight for the credentials the preview depends on.
 *
 * Run it before the first real pull request: it proves the model endpoint, the
 * App identity, and the upload credential, and it names the exact credential
 * class that failed. It never posts a comment.
 *
 * Usage: node .github/ui-preview/doctor.mjs [--mode=all|model|publish]
 */

import { createClient, resolveBotLogin } from './lib/github.mjs';

const args = new Map(
    process.argv
        .slice(2)
        .filter((argument) => argument.startsWith('--'))
        .map((argument) => {
            const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
            return [key, value];
        })
);

const mode = args.get('mode') ?? 'all';
const results = [];

function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}

async function checkModel() {
    const baseUrl = (process.env.UI_PREVIEW_MODEL_BASE_URL ?? '').replace(/\/+$/, '');
    const apiKey = process.env.UI_PREVIEW_MODEL_API_KEY ?? '';
    const model = process.env.UI_PREVIEW_MODEL ?? '';

    if (!baseUrl || !apiKey || !model) {
        record(
            'model configuration',
            false,
            'UI_PREVIEW_MODEL_BASE_URL, UI_PREVIEW_MODEL_API_KEY, and UI_PREVIEW_MODEL are required'
        );
        return;
    }

    record('model configuration', true, `${baseUrl} with ${model}`);

    try {
        const response = await fetch(`${baseUrl}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(30000),
        });
        record('model endpoint', response.ok, `GET /models returned ${response.status}`);
    } catch (error) {
        record('model endpoint', false, error.message);
    }

    try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: 'Answer with one JSON object.' },
                    { role: 'user', content: 'Return {"ok":true}.' },
                ],
            }),
            signal: AbortSignal.timeout(120000),
        });
        const payload = await response.json().catch(() => null);
        const content = payload?.choices?.[0]?.message?.content ?? '';
        let parsed = null;

        try {
            parsed = JSON.parse(content);
        } catch {
            parsed = null;
        }

        record(
            'model json reply',
            response.ok && parsed !== null,
            response.ok
                ? parsed
                    ? 'returned a JSON object'
                    : 'reply was not JSON'
                : `returned ${response.status}`
        );
    } catch (error) {
        record('model json reply', false, error.message);
    }
}

async function checkPublish() {
    const [owner, repo] = String(process.env.GITHUB_REPOSITORY ?? '').split('/');
    const token = process.env.GH_TOKEN ?? '';
    const uploadToken = process.env.ATTACHMENT_TOKEN ?? '';
    const repositoryId = Number(process.env.UI_PREVIEW_REPOSITORY_ID ?? '0');

    if (!owner || !repo || !token) {
        record('app token', false, 'GITHUB_REPOSITORY and GH_TOKEN are required');
        return;
    }

    const client = createClient({ token, owner, repo });

    try {
        const login = await resolveBotLogin(client, process.env.UI_PREVIEW_BOT_LOGIN);
        const isBot = String(login).endsWith('[bot]');
        record('app identity', isBot, `authenticated as ${login || 'unknown'}`);
    } catch (error) {
        record('app identity', false, error.message);
    }

    if (!uploadToken) {
        record('upload credential', false, 'ATTACHMENT_TOKEN is not set');
        return;
    }

    if (!repositoryId) {
        record('upload credential', false, 'UI_PREVIEW_REPOSITORY_ID is not set');
        return;
    }

    try {
        const user = await (
            await fetch('https://api.github.com/user', {
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${uploadToken}`,
                    'User-Agent': 'touchai-ui-preview',
                },
            })
        ).json();
        record(
            'upload identity',
            Boolean(user?.login),
            `authenticated as ${user?.login ?? 'unknown'}`
        );
    } catch (error) {
        record('upload identity', false, error.message);
    }

    try {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'
        );
        const url = await client.uploadAsset({
            token: uploadToken,
            name: 'ui-preview-doctor.png',
            contentType: 'image/png',
            data: png,
            repositoryId,
        });
        record('upload credential', true, url);
    } catch (error) {
        record('upload credential', false, error.message);
    }
}

async function main() {
    if (mode === 'all' || mode === 'model') {
        await checkModel();
    }

    if (mode === 'all' || mode === 'publish') {
        await checkPublish();
    }

    const failed = results.filter((result) => !result.ok);

    if (process.env.GITHUB_STEP_SUMMARY) {
        const rows = results
            .map(
                (result) =>
                    `| ${result.name} | ${result.ok ? 'pass' : 'fail'} | ${result.detail ?? ''} |`
            )
            .join('\n');
        await import('node:fs').then(({ appendFileSync }) =>
            appendFileSync(
                process.env.GITHUB_STEP_SUMMARY,
                `## UI preview doctor\n\n| Check | Result | Detail |\n| --- | --- | --- |\n${rows}\n`
            )
        );
    }

    if (failed.length > 0) {
        console.error(`${failed.length} check(s) failed`);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
});
