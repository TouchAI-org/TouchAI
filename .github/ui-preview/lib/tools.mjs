/**
 * Resolves the ffmpeg binaries the recorder calls.
 *
 * The Homebrew `ffmpeg` formula no longer links libass, so the hosted macOS
 * runner cannot burn captions with the default binary. The workflow installs a
 * build that has the filter and points these variables at it. Every other
 * platform, and any local run, keeps the binary on `PATH`.
 */

export function ffmpegBinary(env = process.env) {
    return env.UI_PREVIEW_FFMPEG || 'ffmpeg';
}

export function ffprobeBinary(env = process.env) {
    return env.UI_PREVIEW_FFPROBE || 'ffprobe';
}
