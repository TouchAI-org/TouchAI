import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(testDirectory, '../..');

describe('Tauri WiX install directory configuration', () => {
    it('defaults clean installs to the product name while reusing Velopack install locations', async () => {
        const config = JSON.parse(
            await readFile(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8')
        ) as {
            productName?: string;
            identifier?: string;
            bundle?: {
                windows?: {
                    wix?: {
                        template?: string;
                    };
                };
            };
        };
        const templatePath = config.bundle?.windows?.wix?.template;

        expect(config.identifier).toBe('org.touch-ai.app');
        expect(config.productName).toBe('TouchAI');
        expect(templatePath).toBe('wix/main.wxs');

        const template = await readFile(
            resolve(desktopRoot, 'src-tauri', templatePath ?? ''),
            'utf8'
        );

        expect(template).toContain('Property Id="INSTALLDIR"');
        expect(template).toContain('Directory Id="INSTALLDIR" Name="{{product_name}}"');
        expect(template).toContain('Id="PrevInstallDirVelopack"');
        expect(template).toContain(
            'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MSI:org.touch-ai.app'
        );
        expect(template).toContain('Name="InstallLocation"');
        expect(template.indexOf('Id="PrevInstallDirNoName"')).toBeLessThan(
            template.indexOf('Id="PrevInstallDirWithName"')
        );
        expect(template.indexOf('Id="PrevInstallDirWithName"')).toBeLessThan(
            template.indexOf('Id="PrevInstallDirVelopack"')
        );
    });
});
