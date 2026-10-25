/**
 * Serves the product font to Storybook.
 *
 * Component baselines have the same fidelity requirement as the end-to-end ones:
 * if the serif face is missing, every story renders a fallback and the baselines
 * describe a font nobody ships. `e2e-tests/e2e-font.js` already knows how to get a
 * verified copy of the exact file (checked against the product's own sha256,
 * cached outside the repository), so this reuses it instead of duplicating the
 * download logic.
 *
 * The file is exposed at `/product-font/<name>`, and
 * `.storybook/preview-head.html` declares `@font-face` for the family the app's
 * tokens ask for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FONT_FILENAME, resolveVerifiedFontFile } from '../e2e-tests/e2e-font.js';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const fontCacheDirectory = path.resolve(desktopRoot, '..', '..', '.e2e-runtime', 'font-cache');

const PRODUCT_FONT_URL = `/product-font/${FONT_FILENAME}`;

export default function productFontPlugin() {
    return {
        name: 'touchai-product-font',
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                if (request.url !== PRODUCT_FONT_URL) {
                    next();
                    return;
                }

                resolveVerifiedFontFile({
                    cacheDirectory: fontCacheDirectory,
                    log: (message) => console.info(`[storybook] ${message}`),
                })
                    .then((fontFile) => {
                        response.setHeader('Content-Type', 'font/woff2');
                        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                        response.end(fs.readFileSync(fontFile));
                    })
                    .catch((error) => {
                        response.statusCode = 500;
                        response.end(`Could not serve the product font: ${error.message}`);
                    });
            });
        },
    };
}
