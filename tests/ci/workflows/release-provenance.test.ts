import { describe, expect, it } from 'vitest';

import { readWorkflow } from './workflow-test-helpers';

describe('given a release assembled from platform build artifacts', () => {
    it('user cannot receive a new feed before its binaries finish uploading', () => {
        const steps = readWorkflow('velopack-build.yml').jobs['deploy-update-channels']!.steps;
        const binaries = steps.findIndex(
            (step) => step.name === 'Deploy update binaries to Cloudflare R2'
        );
        const feeds = steps.findIndex(
            (step) => step.name === 'Deploy update release feeds to Cloudflare R2'
        );
        expect(binaries).toBeGreaterThan(-1);
        expect(feeds).toBeGreaterThan(binaries);
        expect(steps[binaries]?.run).toContain("! -name 'releases.*.json'");
        expect(steps[feeds]?.run).toContain("-name 'releases.*.json'");
        expect(steps[binaries]?.['continue-on-error']).not.toBe(true);
    });

    it('user receives verifiable provenance only after the final checksums and SBOM exist', () => {
        const workflow = readWorkflow('velopack-build.yml');
        const steps = workflow.jobs['build-update-channels']!.steps;
        const checksum = steps.findIndex((step) => step.run?.includes('release-checksums.mjs'));
        const sbom = steps.findIndex((step) => step.uses?.startsWith('anchore/sbom-action@'));
        const version = steps.findIndex((step) => step.run?.includes('set-release-version.mjs'));
        const attest = steps.findIndex((step) => step.uses?.startsWith('actions/attest@'));
        const upload = steps.findIndex((step) => step.run?.includes('gh release upload'));
        expect(sbom).toBeGreaterThan(-1);
        expect(version).toBeGreaterThan(-1);
        expect(sbom).toBeGreaterThan(version);
        expect(checksum).toBeGreaterThan(sbom);
        expect(attest).toBeGreaterThan(checksum);
        expect(upload).toBeGreaterThan(attest);
        expect(steps[attest]?.with?.['subject-path']).toBe(
            '${{ runner.temp }}/touchai-github-release-assets/*'
        );
        expect(steps[sbom]?.with?.['upload-release-assets']).toBe(false);
        expect(steps[sbom]?.with?.['upload-artifact']).toBe(false);
        expect(steps[sbom]?.with?.['syft-version']).toMatch(/^v\d+\.\d+\.\d+$/);
        for (const index of [sbom, attest]) {
            expect(steps[index]?.uses).toMatch(/@[a-f0-9]{40}$/);
        }
        expect(steps.some((step) => step.run?.includes('provenance.sigstore.json'))).toBe(true);
    });

    it('user gets signing permissions only in the attesting job and its reusable-workflow callers', () => {
        const workflow = readWorkflow('velopack-build.yml');
        expect(workflow.jobs['build-update-channels']?.permissions).toMatchObject({
            'id-token': 'write',
            attestations: 'write',
        });
        for (const job of [
            'prepare-release',
            'build-windows',
            'build-macos',
            'build-linux',
            'deploy-update-channels',
        ]) {
            const permissions = workflow.jobs[job]?.permissions as
                | Record<string, string>
                | undefined;
            expect(permissions?.['id-token']).not.toBe('write');
        }
        for (const name of ['release.yml', 'release-please.yml']) {
            expect(readWorkflow(name).jobs['publish-release']?.permissions).toMatchObject({
                'id-token': 'write',
                attestations: 'write',
            });
        }
    });

    it('user receives localized feeds from the same release-note artifact used by packaging', () => {
        const workflow = readWorkflow('velopack-build.yml');
        expect(
            workflow.jobs['prepare-release']?.steps.some((step) =>
                step.run?.includes('prepare-release-notes.mjs')
            )
        ).toBe(true);
        expect(
            workflow.jobs['build-update-channels']?.steps.some((step) =>
                step.run?.includes('--release-notes-by-locale-file')
            )
        ).toBe(true);
    });

    it('user keeps the prepared bilingual release body after platform packaging completes', () => {
        const workflow = readWorkflow('velopack-build.yml');
        const publisher = workflow.jobs['prepare-release']?.steps.find((step) =>
            step.run?.includes('gh release edit')
        );
        expect(publisher?.env?.RELEASE_NOTES_PATH).toBe(
            '${{ runner.temp }}/release-notes/release-body.md'
        );
        for (const job of ['build-windows', 'build-macos', 'build-linux']) {
            expect(
                workflow.jobs[job]?.steps.filter((step) =>
                    /gh release (?:edit|create|upload)/.test(step.run ?? '')
                )
            ).toEqual([]);
        }
    });
});
