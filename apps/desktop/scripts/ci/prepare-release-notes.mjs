import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeLocalizedReleaseNotes } from './release-notes.mjs';
import { previousReleaseTag } from './resolve-release-metadata.mjs';

const ENGLISH_SECTION_START = '## English\n\n<!-- touchai-release-notes:en-US -->\n\n';
const ENGLISH_SECTION_END = '\n\n<!-- /touchai-release-notes:en-US -->';
const CHINESE_SECTION_HEADING = '## 简体中文';

async function readLocalizedNotes(path) {
    try {
        return normalizeLocalizedReleaseNotes(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function requireBilingualNotes(localized, channel, version, source) {
    const english = localized?.['en-US'] ?? localized?.en;
    const chinese = localized?.['zh-CN'];
    if (!english || !chinese) {
        throw new Error(
            `Reviewed bilingual release notes are required for ${channel} ${version}. ` +
                `Provide en-US and zh-CN in release-notes/${source}.`
        );
    }
    return { 'en-US': english, 'zh-CN': chinese };
}

function generatedEnglishNotes(options) {
    const { repository, tag, targetCommitish, channel, version } = options;
    const gh = options.gh ?? ((args) => execFileSync('gh', args, { encoding: 'utf8' }));
    const releases = JSON.parse(
        gh(['api', `repos/${repository}/releases`, '--paginate', '--slurp'])
    ).flat();
    const published = releases.find((release) => release.tag_name === tag)?.body?.trim();
    if (published) {
        return published;
    }

    const args = [
        'api',
        `repos/${repository}/releases/generate-notes`,
        '-f',
        `tag_name=${tag}`,
        '-f',
        `target_commitish=${targetCommitish}`,
    ];
    const baseline = previousReleaseTag(releases, channel, version);
    if (baseline) {
        args.push('-f', `previous_tag_name=${baseline}`);
    }
    const generated = JSON.parse(gh(args)).body?.trim();
    if (!generated) {
        throw new Error('Automatic Nightly notes are empty; cannot publish the release.');
    }
    return generated;
}

export async function prepareReleaseNotes(projectRoot, outputRoot, options) {
    const { channel, version, tag, repository, targetCommitish } = options;
    const eventName = options.eventName ?? 'workflow_dispatch';
    previousReleaseTag([], channel, version);
    if (tag !== `v${version}` || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !targetCommitish) {
        throw new Error(
            'Release notes require a matching version tag, repository and target commit.'
        );
    }

    const versionNotesFile = `${version}.json`;
    let localized = await readLocalizedNotes(join(projectRoot, 'release-notes', versionNotesFile));
    if (localized) {
        localized = requireBilingualNotes(localized, channel, version, versionNotesFile);
    } else if (channel === 'nightly' && eventName === 'schedule') {
        localized = normalizeLocalizedReleaseNotes({
            'en-US': generatedEnglishNotes(options),
        });
    } else {
        requireBilingualNotes(localized, channel, version, versionNotesFile);
    }

    const english = localized['en-US'];
    const body = localized['zh-CN']
        ? `${ENGLISH_SECTION_START}${english}${ENGLISH_SECTION_END}\n\n${CHINESE_SECTION_HEADING}\n\n${localized['zh-CN']}`
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
        eventName: process.env.RELEASE_EVENT_NAME ?? process.env.GITHUB_EVENT_NAME,
    }).catch((error) => {
        console.error(error.message ?? error);
        process.exitCode = 1;
    });
}
