/**
 * Provisions the product face for UI preview evidence.
 *
 * The app downloads Source Han Serif at first launch from mirrors chosen for
 * mainland China. A hosted runner can be slow or unable to reach them, and the
 * screenshots then record the CSS fallback (SimSun or Times), not the face users
 * see. The E2E layer already copies a verified file into its app root; the
 * recorder does the same here, from the same npm artifact through mirrors that
 * work outside China, and verifies the product's own size and sha256.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FONT_FILENAME = 'SourceHanSerifSC-VF.ttf.woff2';
export const FONT_SIZE_BYTES = 21_600_852;
export const FONT_SHA256 = '95bee5840bd5bcc68ada7d9c32fbf40af38a7dadeb77bfae4dd26d85b131ce20';

export const FONT_SOURCES = [
    'https://cdn.jsdelivr.net/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2',
    'https://gcore.jsdelivr.net/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2',
    'https://fastly.jsdelivr.net/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2',
    'https://unpkg.com/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2',
    'https://jsd.onmicrosoft.cn/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2',
    'https://s4.zstatic.net/npm/@fontpkg/source-han-serif-sc-vf@2.3.2/SourceHanSerifSC-VF.ttf.woff2',
];

// The 21.6 MB body has to arrive in one request; a mirror that needs longer is
// broken, so move on instead of holding the record job open.
const FONT_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Checks one candidate against the values the product validates at runtime.
 * Kept pure so the accepted and rejected shapes are testable without a download.
 */
export function verifyFontBuffer(data, expected = { size: FONT_SIZE_BYTES, sha256: FONT_SHA256 }) {
    if (data.length !== expected.size) {
        return { ok: false, detail: `expected ${expected.size} bytes, found ${data.length}` };
    }

    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== expected.sha256) {
        return { ok: false, detail: `expected sha256 ${expected.sha256}, found ${actual}` };
    }

    return { ok: true };
}

const PRODUCT_FONT_EXPECTATION = { size: FONT_SIZE_BYTES, sha256: FONT_SHA256 };

export function isVerifiedFontFile(file, expected = PRODUCT_FONT_EXPECTATION) {
    try {
        return verifyFontBuffer(fs.readFileSync(file), expected).ok;
    } catch {
        return false;
    }
}

/**
 * Copies a verified font into `<app root>/assets/font/` before the app starts.
 *
 * A missing app root means the run uses the user's real profile, which already
 * owns that file; there is nothing for the preview harness to seed.
 */
export async function provisionProductFont({
    appRoot,
    fetchImpl = fetch,
    log = console.log,
    sources = FONT_SOURCES,
    expected = PRODUCT_FONT_EXPECTATION,
} = {}) {
    if (!appRoot) {
        return { ok: true, skipped: true, detail: 'TOUCHAI_APP_ROOT is not set' };
    }

    const target = path.join(appRoot, 'assets', 'font', FONT_FILENAME);
    if (isVerifiedFontFile(target, expected)) {
        return { ok: true, detail: 'verified file already in the app root' };
    }

    const scratch = `${target}.download`;
    fs.mkdirSync(path.dirname(target), { recursive: true });

    let lastError = null;
    for (const url of sources) {
        let host = url;
        try {
            host = new URL(url).host;
            const response = await fetchImpl(url, {
                redirect: 'follow',
                signal: AbortSignal.timeout(FONT_DOWNLOAD_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = Buffer.from(await response.arrayBuffer());
            const verified = verifyFontBuffer(data, expected);
            if (!verified.ok) {
                throw new Error(verified.detail);
            }

            fs.writeFileSync(scratch, data);
            fs.renameSync(scratch, target);
            log(`[preview] product font: downloaded from ${host}`);
            return { ok: true, detail: `downloaded from ${host}` };
        } catch (error) {
            lastError = error;
            fs.rmSync(scratch, { force: true });
            log(`[preview] product font mirror failed (${host}): ${error.message}`);
        }
    }

    return {
        ok: false,
        detail: `could not provision ${FONT_FILENAME}: ${lastError?.message ?? 'no mirror tried'}`,
    };
}
