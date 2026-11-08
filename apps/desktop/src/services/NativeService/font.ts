import { invoke } from './invoke';

export const font = {
    /**
     * Returns a plain TTF for engines that cannot decode the full WOFF2 asset.
     */
    prepareProductFontFile(): Promise<string> {
        return invoke<string>('prepare_product_font_file');
    },
} as const;
