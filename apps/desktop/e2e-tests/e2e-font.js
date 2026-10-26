/**
 * Proves onboarding uses the product's real serif face.
 *
 * TouchAI does not ship Source Han Serif inside the bundle. It downloads
 * `SourceHanSerifSC-VF.ttf.woff2` into `<app root>/assets/font/` on first launch
 * and injects an `@font-face` rule from `src/utils/font.ts`. Every E2E session
 * starts from a fresh `TOUCHAI_APP_ROOT`, so without help that download has not
 * landed by the time a screenshot is taken: the baselines then render every
 * `font-serif` element — settings headings, dialog titles, buttons, message text —
 * in the browser's generic serif, which on Windows is Times New Roman. That is a
 * font no user ever sees, which makes the screenshot useless as visual evidence.
 *
 * The download is 21.6 MB from a CDN. CI would either be slow or flaky depending
 * on the day's connectivity, so the file is fetched once, kept in the Cargo target
 * cache (which CI already persists with `actions/cache`), and copied into each
 * session's app root. The integrity check is the product's own sha256, so a
 * corrupted or substituted download fails loudly instead of silently changing the
 * baselines.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Mirrors `FONT_FILENAME`/`FONT_EXPECTED_SHA256` in `src-tauri/src/core/system/assets.rs`. */
export const FONT_FILENAME = 'SourceHanSerifSC-VF.ttf.woff2';
export const FONT_EXPECTED_SHA256 =
    '95bee5840bd5bcc68ada7d9c32fbf40af38a7dadeb77bfae4dd26d85b131ce20';
export const FONT_EXPECTED_SIZE_BYTES = 21_600_852;

/**
 * The product's CDN list is optimised for end users in mainland China. CI and most
 * contributors are outside it, and jsDelivr serves the identical npm artifact, so
 * the E2E copy prefers jsDelivr and falls back to the product's own mirrors.
 */
export const E2E_FONT_SOURCES = [
    'https://cdn.jsdelivr.net/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2',
    'https://unpkg.com/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2',
    'https://jsd.onmicrosoft.cn/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2',
];

/**
 * Upper bound for one mirror's download, headers and body together.
 *
 * `fetch` bounds itself: undici allows 300 s between body chunks by default, and a
 * server that trickles bytes resets that clock on every chunk, so the sequential
 * mirror loop could otherwise hold the session open for many minutes before it
 * moved on to the next source. The 21.6 MB file arrives in a couple of seconds
 * from a working mirror, so a mirror that needs longer is broken and the loop
 * should try the next one instead of waiting. Passing the signal to `fetch` also
 * bounds the `arrayBuffer()` read, because aborting mid-body rejects it.
 */
const FONT_DOWNLOAD_TIMEOUT_MS = 120_000;

export function sha256OfFile(filePath) {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Downloads a URL to a file, honouring the usual proxy environment variables.
 *
 * Node's global `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY`, and on Windows it also
 * ignores the system proxy settings that PowerShell and browsers use. Contributors
 * behind a local proxy therefore get `fetch failed` with no hint about why, while
 * CI (direct egress) is unaffected. Undici's own fetch resolves the proxy from the
 * environment, so it is used when a proxy is configured and the global fetch
 * otherwise.
 */
async function downloadToFile(url, destination) {
    const proxyConfigured = Boolean(
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy
    );

    if (proxyConfigured) {
        const { fetch: undiciFetch, ProxyAgent } = await import('undici');
        const proxyUrl =
            process.env.HTTPS_PROXY ||
            process.env.https_proxy ||
            process.env.HTTP_PROXY ||
            process.env.http_proxy;

        const response = await undiciFetch(url, {
            dispatcher: new ProxyAgent(proxyUrl),
            signal: AbortSignal.timeout(FONT_DOWNLOAD_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
        return;
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(FONT_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function isValidFontFile(filePath) {
    try {
        const { size } = fs.statSync(filePath);
        if (size !== FONT_EXPECTED_SIZE_BYTES) {
            return false;
        }
        return sha256OfFile(filePath) === FONT_EXPECTED_SHA256;
    } catch {
        return false;
    }
}

/**
 * Returns a verified local copy of the font, downloading it only when the cache is
 * cold. Throws instead of returning an unverified file: a wrong font silently
 * invalidates every baseline, which is exactly the failure this module exists to
 * prevent.
 */
export async function resolveVerifiedFontFile({ cacheDirectory, log = console.info }) {
    const cachedFont = path.join(cacheDirectory, FONT_FILENAME);

    if (isValidFontFile(cachedFont)) {
        return cachedFont;
    }

    fs.mkdirSync(cacheDirectory, { recursive: true });
    const downloadPath = `${cachedFont}.partial`;

    for (const source of E2E_FONT_SOURCES) {
        try {
            log(`[e2e] Downloading the product font for visual fidelity: ${source}`);
            await downloadToFile(source, downloadPath);

            const actualSha256 = sha256OfFile(downloadPath);
            if (
                fs.statSync(downloadPath).size !== FONT_EXPECTED_SIZE_BYTES ||
                actualSha256 !== FONT_EXPECTED_SHA256
            ) {
                throw new Error(
                    `integrity mismatch: expected ${FONT_EXPECTED_SIZE_BYTES} bytes / ${FONT_EXPECTED_SHA256}, got ${fs.statSync(downloadPath).size} bytes / ${actualSha256}`
                );
            }

            fs.renameSync(downloadPath, cachedFont);
            return cachedFont;
        } catch (error) {
            log(`[e2e] Font source failed (${source}): ${error.message}`);
            fs.rmSync(downloadPath, { force: true });
        }
    }

    throw new Error(
        `Could not obtain ${FONT_FILENAME} from any source, so visual baselines would render in a fallback serif. Sources tried: ${E2E_FONT_SOURCES.join(', ')}`
    );
}

/**
 * Copies the verified font into a session's app root, where `assets.rs` looks for
 * it. Returns the destination path so a caller can assert the app actually injected
 * the face.
 */
export async function provisionFontForAppRoot({ appRoot, cacheDirectory, log = console.info }) {
    const fontFile = await resolveVerifiedFontFile({ cacheDirectory, log });
    const targetDirectory = path.join(appRoot, 'assets', 'font');
    const targetPath = path.join(targetDirectory, FONT_FILENAME);

    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.copyFileSync(fontFile, targetPath);

    return targetPath;
}
