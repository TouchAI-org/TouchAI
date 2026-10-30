/**
 * The preview runs the same plan on three native builds. This module keeps the
 * platform names in one place so the workflow, the recorder, and the comment
 * cannot drift apart.
 */

export const PLATFORMS = ['linux', 'macos', 'windows'];

export const PLATFORM_LABELS = {
    linux: 'Linux',
    macos: 'macOS',
    windows: 'Windows',
};

export const CAPTURE_MODES = {
    linux: 'x11grab',
    macos: 'avfoundation',
    windows: 'gdigrab',
};

/**
 * @param {string} [value]
 * @returns {'linux'|'macos'|'windows'}
 */
export function detectPlatform(value = process.env.UI_PREVIEW_PLATFORM || process.platform) {
    const normalized = String(value ?? '').toLowerCase();

    if (normalized === 'darwin' || normalized === 'macos' || normalized === 'mac') {
        return 'macos';
    }

    if (normalized === 'win32' || normalized === 'windows' || normalized === 'win') {
        return 'windows';
    }

    return 'linux';
}

export function platformLabel(platform) {
    return PLATFORM_LABELS[platform] ?? platform;
}

export function captureMode(platform) {
    return CAPTURE_MODES[platform] ?? 'unknown';
}

/**
 * A display smaller than the preview stage cannot show the settings window and
 * the caption strip at the same time. Failing closed is clearer than silently
 * recording a cropped or scaled UI.
 */
export function isUsableDisplay(width, height, minWidth = 1280, minHeight = 900) {
    return Number(width) >= minWidth && Number(height) >= minHeight;
}

/**
 * The Homebrew `ffmpeg` formula no longer links libass, so the hosted macOS
 * runner cannot burn captions with the binary on `PATH`. The workflow installs
 * a build that has the filter and points these variables at it. Every other
 * platform, and any local run, keeps the default binary.
 */
export function ffmpegBinary(env = process.env) {
    return env.UI_PREVIEW_FFMPEG || 'ffmpeg';
}

export function ffprobeBinary(env = process.env) {
    return env.UI_PREVIEW_FFPROBE || 'ffprobe';
}
