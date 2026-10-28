/**
 * Validates evidence, holds the recording minimums, and scans for credentials.
 *
 * Publishing is the only step with credentials, so it re-checks the artifacts
 * instead of trusting the job that produced them: a missing file, a truncated
 * video, or a manifest that points outside the directory must fail closed.
 */

import fs from 'node:fs';
import path from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4_FTYP = Buffer.from('ftyp');

export const MIN_PNG_BYTES = 1024;
export const MIN_MP4_BYTES = 8192;
export const MIN_VIDEO_SECONDS = 6;
export const MIN_VIDEO_FRAMES = 60;
export const MIN_DISTINCT_STATES = 5;
export const MIN_COVERAGE = 0.8;

const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function findSecret(text) {
    const value = String(text ?? '');

    for (const pattern of SECRET_PATTERNS) {
        const match = pattern.exec(value);

        if (match) {
            return { kind: pattern.source, sample: `${match[0].slice(0, 6)}...` };
        }
    }

    return null;
}

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function readPngSize(buffer) {
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return null;
    }

    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function isMp4(buffer) {
    return buffer.length > 12 && buffer.subarray(4, 8).equals(MP4_FTYP);
}

/**
 * @param {string} evidenceDir
 * @param {object} manifest
 * @returns {{ ok: boolean, errors: string[], assets: { shots: string[], video: string | null } }}
 */
export function validateEvidence(evidenceDir, manifest) {
    const errors = [];
    const root = path.resolve(evidenceDir);
    const shots = [];
    let video = null;

    if (!manifest || typeof manifest !== 'object') {
        return {
            ok: false,
            errors: ['manifest.json is missing or not an object'],
            assets: { shots, video },
        };
    }

    if (manifest.version !== 1) {
        errors.push('manifest version must be 1');
    }

    if (!/^[0-9a-f]{7,40}$/.test(String(manifest.sha ?? ''))) {
        errors.push('manifest sha is not a commit sha');
    }

    const scenes = Array.isArray(manifest.scenes) ? manifest.scenes : [];

    if (scenes.length === 0) {
        errors.push('the manifest has no scenes');
    }

    for (const scene of scenes) {
        for (const shot of scene?.shots ?? []) {
            const relative = String(shot?.file ?? '');
            const absolute = path.resolve(root, relative);

            if (!relative || !isInside(root, absolute)) {
                errors.push(`shot path escapes the evidence directory: ${relative}`);
                continue;
            }

            if (!fs.existsSync(absolute)) {
                errors.push(`shot is missing: ${relative}`);
                continue;
            }

            const buffer = fs.readFileSync(absolute);
            const size = readPngSize(buffer);

            if (!size) {
                errors.push(`shot is not a PNG: ${relative}`);
                continue;
            }

            if (buffer.length < MIN_PNG_BYTES) {
                errors.push(`shot is too small to be real evidence: ${relative}`);
                continue;
            }

            if (size.width < 200 || size.height < 40) {
                errors.push(`shot is smaller than any app window: ${relative}`);
                continue;
            }

            shots.push(relative);
        }
    }

    if (manifest.video) {
        const relative = String(manifest.video);
        const absolute = path.resolve(root, relative);
        const info = manifest.videoInfo;

        if (!isInside(root, absolute) || !fs.existsSync(absolute)) {
            errors.push(`video is missing: ${relative}`);
        } else {
            const buffer = fs.readFileSync(absolute);

            if (!isMp4(buffer)) {
                errors.push('video is not an mp4');
            } else if (buffer.length < MIN_MP4_BYTES) {
                errors.push('video is too small to be real evidence');
            } else {
                video = relative;
            }

            if (!info || typeof info !== 'object') {
                errors.push('video metadata is missing, so the recording cannot be checked');
            } else {
                const duration = Number(info.durationSeconds ?? 0);
                const frames = Number(info.frames ?? 0);
                const distinctStates = Number(info.distinctStates ?? 0);
                const coverage = Number(info.coverage ?? 0);
                const width = Number(info.width ?? 0);
                const height = Number(info.height ?? 0);

                if (duration < MIN_VIDEO_SECONDS) {
                    errors.push(`video is shorter than ${MIN_VIDEO_SECONDS}s`);
                }

                if (frames < MIN_VIDEO_FRAMES) {
                    errors.push(`video has fewer than ${MIN_VIDEO_FRAMES} frames`);
                }

                if (distinctStates < MIN_DISTINCT_STATES) {
                    errors.push(
                        `video has fewer than ${MIN_DISTINCT_STATES} distinct states, so it is effectively a still`
                    );
                }

                if (coverage < MIN_COVERAGE) {
                    errors.push('video covers less than 80% of the recording session');
                }

                if (width < 320 || height < 240) {
                    errors.push('video is smaller than any app window');
                }
            }
        }
    }

    if (shots.length === 0 && !video) {
        errors.push('the manifest has no usable evidence');
    }

    return { ok: errors.length === 0, errors, assets: { shots, video } };
}

export const MIME_TYPES = {
    '.png': 'image/png',
    '.mp4': 'video/mp4',
};
