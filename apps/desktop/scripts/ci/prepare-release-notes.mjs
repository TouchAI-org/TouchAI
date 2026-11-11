import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeLocalizedReleaseNotes } from './release-notes.mjs';
import { previousReleaseTag } from './resolve-release-metadata.mjs';

const ENGLISH_SECTION_START = '## English\n\n<!-- touchai-release-notes:en-US -->\n\n';
const ENGLISH_SECTION_END = '\n\n<!-- /touchai-release-notes:en-US -->';
const CHINESE_SECTION_HEADING = '## 简体中文';
const RELEASE_PLEASE_CHANGELOG = 'CHANGELOG.md';

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Release Please writes one level-two section per version. Keep the exact
 * version section so Stable notes stay tied to the release PR's changelog
 * instead of a separately generated comparison.
 */
function releasePleaseChangelogSection(changelog, version) {
    const text = typeof changelog === 'string' ? changelog.replace(/\r\n/g, '\n') : '';
    const escapedVersion = escapeRegExp(version);
    const heading = new RegExp(
        `^##\\s+(?:\\[${escapedVersion}\\]|${escapedVersion}(?:\\s|$))`,
        'm'
    );
    const match = heading.exec(text);
    if (!match) {
        return null;
    }

    const contentStart = match.index + match[0].length;
    const nextSection = /^##\s+/m.exec(text.slice(contentStart));
    const sectionEnd = nextSection ? contentStart + nextSection.index : text.length;
    return text.slice(match.index, sectionEnd).trim() || null;
}

async function readReleasePleaseEnglishNotes(projectRoot, channel, version) {
    if (channel !== 'stable') {
        return null;
    }
    try {
        return releasePleaseChangelogSection(
            await readFile(join(projectRoot, RELEASE_PLEASE_CHANGELOG), 'utf8'),
            version
        );
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

/**
 * Read back what a previous run published so a retry after a clean checkout
 * keeps every reviewed language instead of regenerating English only.
 */
function parsePublishedReleaseBody(body) {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) {
        return { english: null, translations: {} };
    }
    if (!text.startsWith(ENGLISH_SECTION_START)) {
        return { english: text, translations: {} };
    }

    const englishEnd = text.indexOf(ENGLISH_SECTION_END, ENGLISH_SECTION_START.length);
    if (englishEnd < 0) {
        throw new Error('Published release notes have an incomplete English section.');
    }

    const english = text.slice(ENGLISH_SECTION_START.length, englishEnd).trim();
    const translations = {};
    const chineseStart = text.indexOf(
        CHINESE_SECTION_HEADING,
        englishEnd + ENGLISH_SECTION_END.length
    );
    if (chineseStart >= 0) {
        const chinese = text.slice(chineseStart + CHINESE_SECTION_HEADING.length).trim();
        if (chinese) {
            translations['zh-CN'] = chinese;
        }
    }

    return { english: english || null, translations };
}

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
        const published = parsePublishedReleaseBody(
            releases.find((release) => release.tag_name === tag)?.body
        );
        english = published.english;
        for (const [locale, content] of Object.entries(published.translations)) {
            if (!localized[locale]) {
                localized[locale] = content;
            }
        }
        const releasePleaseEnglish = await readReleasePleaseEnglishNotes(
            projectRoot,
            channel,
            version
        );
        if (
            releasePleaseEnglish &&
            (!published.english || published.english.trim() === releasePleaseEnglish.trim())
        ) {
            english = releasePleaseEnglish;
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
    }).catch((error) => {
        console.error(error.message ?? error);
        process.exitCode = 1;
    });
}
