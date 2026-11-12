import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

import { buildUpdateChannels } from '../../scripts/ci/build-update-channels.mjs';
import { prepareReleaseNotes } from '../../scripts/ci/prepare-release-notes.mjs';
import { previousReleaseTag } from '../../scripts/ci/resolve-release-metadata.mjs';

const roots: string[] = [];
const notes = {
    'en-US': '## Changes\n\n1. **Safer updates**: interrupted downloads can resume (#776)',
    'zh-CN': '## 更新内容\n\n1. **更安全的更新**：中断的下载可以继续（#776）',
};

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-localized-notes-'));
    roots.push(root);
    await writeFile(join(root, 'product.json'), JSON.stringify(APP_PRODUCT_CONFIG));
    return root;
}

async function writeNotes(root: string, version: string, content: Record<string, unknown> = notes) {
    await mkdir(join(root, 'release-notes'), { recursive: true });
    await writeFile(join(root, 'release-notes', `${version}.json`), JSON.stringify(content));
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('given releases in several channels', () => {
    const releases = [
        { tag_name: 'v1.2.0-beta.9' },
        { tag_name: 'v1.2.0-beta.10' },
        { tag_name: 'v1.2.0-beta.11' },
        { tag_name: 'v1.3.0-beta.1' },
        { tag_name: 'v1.2.0-beta.10.1', draft: true },
        { tag_name: 'v1.2.0-nightly.20261101' },
        { tag_name: 'v1.1.0' },
        { tag_name: 'unversioned' },
    ];

    it('user gets the preceding published beta as the comparison baseline', () => {
        expect(previousReleaseTag(releases, 'beta', '1.2.0-beta.11')).toBe('v1.2.0-beta.10');
        expect(previousReleaseTag(releases, 'beta', '1.3.0-beta.1')).toBe('v1.2.0-beta.11');
    });

    it('user gets a stable baseline only when publishing the first release of a channel', () => {
        expect(previousReleaseTag(releases, 'nightly', '1.2.0-nightly.20261102')).toBe(
            'v1.2.0-nightly.20261101'
        );
        expect(previousReleaseTag(releases, 'beta', '1.2.0-beta.1')).toBe('v1.1.0');
        expect(previousReleaseTag([], 'beta', '1.0.0-beta.1')).toBeNull();
    });

    it('user gets a clear validation error when the release version does not match its channel', () => {
        expect(() => previousReleaseTag(releases, 'beta', '1.2.0')).toThrow(/beta/i);
    });
});

describe('given reviewed bilingual release content', () => {
    it('user receives both languages through publishing while older clients keep English Markdown', async () => {
        const root = await fixture();
        await writeNotes(root, '1.2.0-beta.11');
        const output = join(root, 'notes');
        await prepareReleaseNotes(root, output, {
            repository: 'TouchAI-org/TouchAI',
            channel: 'beta',
            version: '1.2.0-beta.11',
            tag: 'v1.2.0-beta.11',
            targetCommitish: 'main',
        });

        expect(await readFile(join(output, 'release-notes.md'), 'utf8')).toBe(
            `${notes['en-US']}\n`
        );
        expect(JSON.parse(await readFile(join(output, 'release-notes.json'), 'utf8'))).toEqual(
            notes
        );
        const body = await readFile(join(output, 'release-body.md'), 'utf8');
        expect(body).toContain(notes['en-US']);
        expect(body).toContain(notes['zh-CN']);

        const dist = join(root, 'dist');
        await buildUpdateChannels(root, dist, new Date('2026-11-10T00:00:00Z'), {
            release: {
                channel: 'beta',
                version: '1.2.0-beta.11',
                tag: 'v1.2.0-beta.11',
                prerelease: true,
                releaseNotesByLocaleFile: join(output, 'release-notes.json'),
            },
        });
        const feedPath = join(
            dist,
            new URL(APP_PRODUCT_CONFIG.services.updates.baseUrl).pathname,
            'releases.beta.json'
        );
        const feed = JSON.parse(await readFile(feedPath, 'utf8'));
        expect(feed.Latest.releaseNotes).toBe(notes['en-US']);
        expect(feed.Latest.releaseNotesByLocale).toEqual(notes);
        expect(feed.SchemaVersion).toBe(1);
    });

    it('user is blocked when a release has no reviewed bilingual file', async () => {
        const root = await fixture();
        await expect(
            prepareReleaseNotes(root, join(root, 'notes'), {
                repository: 'TouchAI-org/TouchAI',
                channel: 'stable',
                version: '1.2.0',
                tag: 'v1.2.0',
                targetCommitish: 'main',
            })
        ).rejects.toThrow(/Reviewed bilingual release notes/);
        await expect(readFile(join(root, 'notes/release-notes.json'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('user is blocked when one of the two reviewed languages is missing', async () => {
        const root = await fixture();
        await writeNotes(root, '1.2.0', { 'en-US': notes['en-US'] });
        await expect(
            prepareReleaseNotes(root, join(root, 'notes'), {
                repository: 'TouchAI-org/TouchAI',
                channel: 'stable',
                version: '1.2.0',
                tag: 'v1.2.0',
                targetCommitish: 'main',
            })
        ).rejects.toThrow(/Provide en-US and zh-CN/);
    });

    it('user can correct invalid localized content without publishing partial output', async () => {
        const root = await fixture();
        await mkdir(join(root, 'release-notes'));
        await writeFile(join(root, 'release-notes/1.2.0.json'), '{"zh-CN":123}');
        await expect(
            prepareReleaseNotes(root, join(root, 'notes'), {
                repository: 'TouchAI-org/TouchAI',
                channel: 'stable',
                version: '1.2.0',
                tag: 'v1.2.0',
                targetCommitish: 'main',
            })
        ).rejects.toThrow(/zh-CN/);
        await expect(readFile(join(root, 'notes/release-notes.json'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('user keeps the reviewed notes when a publication is retried', async () => {
        const root = await fixture();
        await writeNotes(root, '1.2.0');
        const output = join(root, 'notes');
        const options = {
            repository: 'TouchAI-org/TouchAI',
            channel: 'stable' as const,
            version: '1.2.0',
            tag: 'v1.2.0',
            targetCommitish: 'main',
        };

        await prepareReleaseNotes(root, output, options);
        const body = await readFile(join(output, 'release-body.md'), 'utf8');
        await prepareReleaseNotes(root, output, options);

        expect(await readFile(join(output, 'release-body.md'), 'utf8')).toBe(body);
        expect(JSON.parse(await readFile(join(output, 'release-notes.json'), 'utf8'))).toEqual(
            notes
        );
    });

    it('user gets generated English notes for an automatic Nightly exception', async () => {
        const root = await fixture();
        const requests: string[][] = [];

        await prepareReleaseNotes(root, join(root, 'notes'), {
            repository: 'TouchAI-org/TouchAI',
            channel: 'nightly',
            version: '1.2.0-nightly.20261102.1.1',
            tag: 'v1.2.0-nightly.20261102.1.1',
            targetCommitish: 'main',
            eventName: 'schedule',
            gh: (args) => {
                requests.push(args);
                return args.some((arg) => arg.endsWith('/generate-notes'))
                    ? JSON.stringify({ body: 'Generated Nightly notes' })
                    : JSON.stringify([[{ tag_name: 'v1.2.0-nightly.20261101' }]]);
            },
        });

        expect(requests[requests.length - 1]).toContain(
            'previous_tag_name=v1.2.0-nightly.20261101'
        );
        expect(JSON.parse(await readFile(join(root, 'notes/release-notes.json'), 'utf8'))).toEqual({
            'en-US': 'Generated Nightly notes',
        });
        expect(await readFile(join(root, 'notes/release-body.md'), 'utf8')).toBe(
            'Generated Nightly notes\n'
        );
    });

    it('user cannot publish a manual Nightly without version-specific notes', async () => {
        const root = await fixture();
        await expect(
            prepareReleaseNotes(root, join(root, 'notes'), {
                repository: 'TouchAI-org/TouchAI',
                channel: 'nightly',
                version: '1.2.0-nightly.20261102.1.1',
                tag: 'v1.2.0-nightly.20261102.1.1',
                targetCommitish: 'main',
                eventName: 'workflow_dispatch',
            })
        ).rejects.toThrow(/1\.2\.0-nightly\.20261102\.1\.1\.json/);
    });
});
