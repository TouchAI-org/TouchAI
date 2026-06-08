import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const buildScriptSource = readFileSync(resolve(process.cwd(), 'src-tauri/build.rs'), 'utf8');

function readNumericConstant(name: string) {
    const match = buildScriptSource.match(new RegExp(`const ${name}: \\w+ = (\\d+(?:_\\d+)*)`));
    const rawValue = match?.[1];

    if (!rawValue) {
        throw new Error(`Unable to find ${name} in build.rs`);
    }

    return Number.parseInt(rawValue.replace(/_/g, ''), 10);
}

describe('bundled binary download policy', () => {
    it('keeps CI builds resilient to transient release download failures', () => {
        expect(readNumericConstant('BUNDLED_DOWNLOAD_MAX_ATTEMPTS')).toBeGreaterThanOrEqual(6);
        expect(readNumericConstant('BUNDLED_DOWNLOAD_RETRY_BASE_DELAY_MS')).toBeGreaterThanOrEqual(
            1500
        );
        expect(buildScriptSource).toContain('bundled_download_retry_delay_ms');
        expect(buildScriptSource).not.toContain(
            'BUNDLED_DOWNLOAD_RETRY_BASE_DELAY_MS * attempt as u64'
        );
    });
});
