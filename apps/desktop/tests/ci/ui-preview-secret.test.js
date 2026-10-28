import { describe, expect, it } from 'vitest';

import { findSecret } from '../../../../.github/ui-preview/lib/secret-scan.mjs';

describe('user publishes evidence', () => {
    it('user gets no warning for ordinary prose and links', () => {
        expect(
            findSecret(
                'The shortcuts section groups its rows. https://github.com/user-attachments/assets/abc-123'
            )
        ).toBeNull();
    });

    it('user gets a warning when an api key reached the evidence', () => {
        const found = findSecret('token sk-abcdefghijklmnopqrstuvwx was pasted');

        expect(found).not.toBeNull();
        expect(found.sample).toBe('sk-abc...');
    });

    it('user gets a warning when a github token reached the evidence', () => {
        expect(findSecret('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).not.toBeNull();
    });

    it('user gets a warning when a private key block reached the evidence', () => {
        expect(findSecret('-----BEGIN RSA PRIVATE KEY-----')).not.toBeNull();
    });
});
