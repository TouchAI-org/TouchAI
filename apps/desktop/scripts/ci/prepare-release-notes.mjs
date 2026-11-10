import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeLocalizedReleaseNotes } from './release-notes.mjs';
import { previousReleaseTag } from './resolve-release-metadata.mjs';

const ENGLISH_SECTION_START = '## English\n\n<!-- touchai-release-notes:en-US -->\n\n';
const ENGLISH_SECTION_END = '\n\n<!-- /touchai-release-notes:en-US -->';

export async function prepareReleaseNotes(projectRoot, outputRoot, options) {
    const { channel, version, tag, repository, targetCommitish } = options;
    previousReleaseTag([], channel, version);
    if (tag !== `v${version}` || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !targetCommitish) {
        throw new Error(
            'Release notes require a matching version tag, repository and target commit.'
        );
    }

    let localized = {};
    try {
        localized = normalizeLocalizedReleaseNotes(
            JSON.parse(
                await readFile(join(projectRoot, 'release-notes', `${version}.json`), 'utf8')
            )
        );
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    let english = localized['en-US'] || localized.en;
    if (!english) {
        const gh = options.gh ?? ((args) => execFileSync('gh', args, { encoding: 'utf8' }));
        const releases = JSON.parse(
            gh(['api', `repos/${repository}/releases`, '--paginate', '--slurp'])
        ).flat();
        english = releases.find((release) => release.tag_name === tag)?.body?.trim();
        if (english?.startsWith(ENGLISH_SECTION_START)) {
            const sectionEnd = english.indexOf(ENGLISH_SECTION_END, ENGLISH_SECTION_START.length);
            if (sectionEnd < 0) {
                throw new Error('Published release notes have an incomplete English section.');
            }
            english = english.slice(ENGLISH_SECTION_START.length, sectionEnd).trim();
        }
        if (!english) {
            const previousTag = previousReleaseTag(releases, channel, version);
            const args = [
                'api',
                `repos/${repository}/releases/generate-notes`,
                '-f',
                `tag_name=${tag}`,
                '-f',
                `target_commitish=${targetCommitish}`,
            ];
            if (previousTag) {
                args.push('-f', `previous_tag_name=${previousTag}`);
            }
            english = JSON.parse(gh(args)).body?.trim();
        }
        if (!english) {
            throw new Error('Release notes are empty; provide reviewed notes before publishing.');
        }
    }

    localized = normalizeLocalizedReleaseNotes({ ...localized, 'en-US': english });
    const body = localized['zh-CN']
        ? `${ENGLISH_SECTION_START}${english}${ENGLISH_SECTION_END}\n\n## 简体中文\n\n${localized['zh-CN']}`
        : english;
    await mkdir(outputRoot, { recursive: true });
    await Promise.all([
        writeFile(join(outputRoot, 'release-notes.md'), `${english}\n`),
        writeFile(
            join(outputRoot, 'release-notes.json'),
            `${JSON.stringify(localized, null, 4)}\n`
        ),
        writeFile(join(outputRoot, 'release-body.md'), `${body}\n`),
    ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    prepareReleaseNotes(process.cwd(), process.argv[2], {
        channel: process.env.RELEASE_CHANNEL,
        version: process.env.RELEASE_VERSION,
        tag: process.env.RELEASE_TAG,
        repository: process.env.GITHUB_REPOSITORY,
        targetCommitish: process.env.TARGET_COMMITISH,
    }).catch((error) => {
        console.error(error.message ?? error);
        process.exitCode = 1;
    });
}
