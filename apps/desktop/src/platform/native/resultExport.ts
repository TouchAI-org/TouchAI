// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { invoke } from './invoke';

export const resultExport = {
    writeHtml(destination: string, html: string): Promise<void> {
        return invoke('result_export_html', { destination, html });
    },
};
