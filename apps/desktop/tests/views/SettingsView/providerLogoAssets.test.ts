import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { providerDriverDefinitions } from '@/services/AgentService/infrastructure/providers';

describe('provider logo assets', () => {
    it('has an asset for every provider driver logo definition', () => {
        const providerLogoDirectory = join(process.cwd(), 'src/assets/logos/providers');

        const missingLogos = providerDriverDefinitions
            .map((definition) => definition.logo)
            .filter((logo, index, logos) => logos.indexOf(logo) === index)
            .filter((logo) => !existsSync(join(providerLogoDirectory, logo)));

        expect(missingLogos).toEqual([]);
    });
});
