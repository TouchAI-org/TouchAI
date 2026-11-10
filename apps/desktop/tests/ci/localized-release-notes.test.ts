import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

import { buildUpdateChannels } from '../../scripts/ci/build-update-channels.mjs';
import { prepareReleaseNotes } from '../../scripts/ci/prepare-release-notes.mjs';
import { previousReleaseTag } from '../../scripts/ci/resolve-release-metadata.mjs';

const roots: string[] = [];

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-localized-notes-'));
    roots.push(root);
    await writeFile(join(root, 'product.json'), JSON.stringify(APP_PRODUCT_CONFIG));
    return root;
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

    it('user gets the preceding published beta when generating the next beta notes', () => {
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
    const notes = {
        'en-US': '## Changes\n- Safer updates',
        'zh-CN': '## 更新内容\n- 更安全的更新',
    };

    it('user receives both languages through publishing while older clients keep English Markdown', async () => {
        const root = await fixture();
        await mkdir(join(root, 'release-notes'));
        await writeFile(join(root, 'release-notes/1.2.0-beta.11.json'), JSON.stringify(notes));
        const output = join(root, 'notes');
        await prepareReleaseNotes(root, output, {
            repository: 'TouchAI-org/TouchAI',
            channel: 'beta',
            version: '1.2.0-beta.11',
            tag: 'v1.2.0-beta.11',
            targetCommitish: 'main',
            gh: () => JSON.stringify([[{ tag_name: 'v1.2.0-beta.10' }]]),
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
                releaseNotesFile: join(output, 'release-notes.md'),
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

    it('user gets generated notes for the explicit previous beta when a translation is absent', async () => {
        const root = await fixture();
        const requests: string[][] = [];
        await prepareReleaseNotes(root, join(root, 'notes'), {
            repository: 'TouchAI-org/TouchAI',
            channel: 'beta',
            version: '1.2.0-beta.11',
            tag: 'v1.2.0-beta.11',
            targetCommitish: 'main',
            gh: (args) => {
                requests.push(args);
                return args.some((arg) => arg.endsWith('/generate-notes'))
                    ? JSON.stringify({ body: '- Fixed a bug' })
                    : JSON.stringify([[{ tag_name: 'v1.2.0-beta.10' }]]);
            },
        });
        expect(requests[requests.length - 1]).toContain('previous_tag_name=v1.2.0-beta.10');
        expect(JSON.parse(await readFile(join(root, 'notes/release-notes.json'), 'utf8'))).toEqual({
            'en-US': '- Fixed a bug',
        });
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
                gh: () => '[]',
            })
        ).rejects.toThrow(/zh-CN/);
        await expect(readFile(join(root, 'notes/release-notes.md'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('user keeps reviewed release text when a publication is retried', async () => {
        const root = await fixture();
        await prepareReleaseNotes(root, join(root, 'notes'), {
            repository: 'TouchAI-org/TouchAI',
            channel: 'stable',
            version: '1.2.0',
            tag: 'v1.2.0',
            targetCommitish: 'main',
            gh: () => JSON.stringify([[{ tag_name: 'v1.2.0', body: 'Reviewed English notes' }]]),
        });
        expect(await readFile(join(root, 'notes/release-notes.md'), 'utf8')).toBe(
            'Reviewed English notes\n'
        );
    });

    it('user keeps both published languages when a retry runs from a clean checkout', async () => {
        const root = await fixture();
        const publishedBody = `## English\n\n<!-- touchai-release-notes:en-US -->\n\n${notes['en-US']}\n\n<!-- /touchai-release-notes:en-US -->\n\n## 简体中文\n\n${notes['zh-CN']}`;
        await prepareReleaseNotes(root, join(root, 'notes'), {
            repository: 'TouchAI-org/TouchAI',
            channel: 'beta',
            version: '1.2.0-beta.11',
            tag: 'v1.2.0-beta.11',
            targetCommitish: 'main',
            gh: () => JSON.stringify([[{ tag_name: 'v1.2.0-beta.11', body: publishedBody }]]),
        });

        expect(JSON.parse(await readFile(join(root, 'notes/release-notes.json'), 'utf8'))).toEqual(
            notes
        );
        expect(await readFile(join(root, 'notes/release-body.md'), 'utf8')).toBe(
            `${publishedBody}\n`
        );
    });

    it('user does not get an invented translation when the published body is English only', async () => {
        const root = await fixture();
        const publishedBody =
            '## English\n\n<!-- touchai-release-notes:en-US -->\n\nEnglish only\n\n<!-- /touchai-release-notes:en-US -->';
        await prepareReleaseNotes(root, join(root, 'notes'), {
            repository: 'TouchAI-org/TouchAI',
            channel: 'stable',
            version: '1.2.0',
            tag: 'v1.2.0',
            targetCommitish: 'main',
            gh: () => JSON.stringify([[{ tag_name: 'v1.2.0', body: publishedBody }]]),
        });

        expect(JSON.parse(await readFile(join(root, 'notes/release-notes.json'), 'utf8'))).toEqual({
            'en-US': 'English only',
        });
        expect(await readFile(join(root, 'notes/release-body.md'), 'utf8')).toBe('English only\n');
    });

    it('user keeps separate languages when a release with generated English is published again', async () => {
        const root = await fixture();
        await mkdir(join(root, 'release-notes'));
        await writeFile(
            join(root, 'release-notes/1.2.0-beta.11.json'),
            JSON.stringify({ 'zh-CN': notes['zh-CN'] })
        );
        let publishedBody = '';
        const options = {
            repository: 'TouchAI-org/TouchAI',
            channel: 'beta' as const,
            version: '1.2.0-beta.11',
            tag: 'v1.2.0-beta.11',
            targetCommitish: 'main',
            gh: (args: string[]) =>
                args.some((arg) => arg.endsWith('/generate-notes'))
                    ? JSON.stringify({ body: notes['en-US'] })
                    : JSON.stringify([
                          [
                              { tag_name: 'v1.2.0-beta.10' },
                              { tag_name: 'v1.2.0-beta.11', body: publishedBody },
                          ],
                      ]),
        };
        const output = join(root, 'notes');
        await prepareReleaseNotes(root, output, options);
        publishedBody = await readFile(join(output, 'release-body.md'), 'utf8');
        await prepareReleaseNotes(root, output, options);

        expect(JSON.parse(await readFile(join(output, 'release-notes.json'), 'utf8'))).toEqual(
            notes
        );
        expect(await readFile(join(output, 'release-body.md'), 'utf8')).toBe(publishedBody);
    });

    it('user gets a repairable error instead of publishing a truncated generated language section', async () => {
        const root = await fixture();
        await expect(
            prepareReleaseNotes(root, join(root, 'notes'), {
                repository: 'TouchAI-org/TouchAI',
                channel: 'stable',
                version: '1.2.0',
                tag: 'v1.2.0',
                targetCommitish: 'main',
                gh: () =>
                    JSON.stringify([
                        [
                            {
                                tag_name: 'v1.2.0',
                                body: '## English\n\n<!-- touchai-release-notes:en-US -->\n\nIncomplete',
                            },
                        ],
                    ]),
            })
        ).rejects.toThrow(/incomplete English section/);
        await expect(readFile(join(root, 'notes/release-notes.md'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });
});
