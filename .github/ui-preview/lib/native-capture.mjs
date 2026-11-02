/**
 * Native screen recording for each desktop platform.
 *
 * The video is always a real screen capture, not a sequence of screenshots.
 * The capture is cropped to the configured preview stage in the caption pass
 * so Linux, macOS, and Windows produce the same output shape even when the
 * runner display is larger than the stage.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { captureMode, ffmpegBinary } from './platform.mjs';
import { resolveCaptureProfile } from './profile.mjs';

const FIRST_FRAME_TIMEOUT_MS = 20000;
const STOP_TIMEOUT_MS = 10000;

export function recordingFps(platform) {
    // avfoundation negotiates 30 fps reliably; the shared Linux runner drops
    // frames above 10 fps, and gdigrab is stable at 10 fps.
    return platform === 'macos' ? 30 : 10;
}

/**
 * @param {{ platform: string, display?: string, width: number, height: number, file: string }} input
 */
export function buildRecordingArgs({ platform, display = ':99', width, height, file }) {
    const fps = String(recordingFps(platform));
    // The overlay draws the cursor path, so a second OS pointer would only be noise.
    const input =
        platform === 'macos'
            ? [
                  '-f',
                  'avfoundation',
                  '-framerate',
                  fps,
                  '-capture_cursor',
                  '0',
                  '-capture_mouse_clicks',
                  '0',
                  '-pixel_format',
                  'uyvy422',
                  '-video_size',
                  `${width}x${height}`,
                  '-i',
                  'Capture screen 0:none',
              ]
            : platform === 'windows'
              ? ['-f', 'gdigrab', '-framerate', fps, '-draw_mouse', '0', '-i', 'desktop']
              : [
                    '-f',
                    'x11grab',
                    '-framerate',
                    fps,
                    '-draw_mouse',
                    '0',
                    '-thread_queue_size',
                    '1024',
                    '-video_size',
                    `${width}x${height}`,
                    '-i',
                    `${display}.0+0,0`,
                ];

    return [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        ...input,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-crf',
        '26',
        '-r',
        '30',
        '-fps_mode',
        'cfr',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-nostats',
        file,
    ];
}

/**
 * The runner display may be larger than the preview stage. The recorder keeps
 * the app window inside the top-left stage, so cropping there keeps the window
 * and drops the rest of the desktop.
 */
export function buildCropFilter(width, height, stage = resolveCaptureProfile().physical) {
    if (Number(width) <= stage.width && Number(height) <= stage.height) {
        return null;
    }

    return `crop=${stage.width}:${stage.height}:0:0`;
}

export function parseDisplaySize(
    env = process.env,
    platform = 'linux',
    profile = resolveCaptureProfile(env)
) {
    const fallback = platform === 'linux' ? profile.physical : { width: 0, height: 0 };
    const width = Number(env.UI_PREVIEW_DISPLAY_WIDTH ?? fallback.width);
    const height = Number(env.UI_PREVIEW_DISPLAY_HEIGHT ?? fallback.height);

    return {
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
    };
}

async function waitForFirstFrame(child, stderrRef) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let progress = '';

        const finish = (error) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            child.stdout.off('data', onData);
            child.off('exit', onExit);
            child.off('error', onError);

            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };
        const onData = (chunk) => {
            progress += chunk.toString();

            if (/frame=\s*[1-9]\d*/.test(progress) || /out_time_ms=[1-9]\d*/.test(progress)) {
                finish();
                return;
            }

            // Keep the buffer bounded when ffmpeg emits a lot of progress.
            progress = progress.slice(-4096);
        };
        const onExit = (code) => {
            finish(
                new Error(
                    `ffmpeg exited before the first frame (${code}): ${stderrRef.value.slice(0, 500)}`
                )
            );
        };
        const onError = (error) => {
            finish(new Error(`ffmpeg could not start: ${error.message}`));
        };
        const timer = setTimeout(() => {
            finish(
                new Error(
                    `ffmpeg did not produce a first frame within ${FIRST_FRAME_TIMEOUT_MS}ms: ${stderrRef.value.slice(0, 500)}`
                )
            );
        }, FIRST_FRAME_TIMEOUT_MS);

        child.stdout.on('data', onData);
        child.once('exit', onExit);
        child.once('error', onError);
    });
}

/**
 * Starts a native recording and waits until the first frame is on disk, so the
 * caption timeline and the coverage check start at the same moment as the
 * video.
 */
export async function startNativeRecording({ platform, display, width, height, file }) {
    const args = buildRecordingArgs({ platform, display, width, height, file });
    const child = spawn(ffmpegBinary(), args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: platform === 'linux' ? { ...process.env, DISPLAY: display } : process.env,
        windowsHide: true,
    });
    const stderrRef = { value: '' };
    child.stderr.on('data', (chunk) => {
        stderrRef.value += chunk.toString();
    });

    try {
        await waitForFirstFrame(child, stderrRef);
    } catch (error) {
        // A timed-out ffmpeg keeps the desktop grab open and keeps Node alive.
        // Kill it before reporting the failure so the screenshots can finish.
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
        fs.rmSync(file, { force: true });
        throw error;
    }

    // `-progress pipe:1` keeps writing. Without a reader the pipe fills and
    // blocks ffmpeg before the recording is stopped.
    child.stdout.resume();
    const startedAt = Date.now();

    return {
        mode: captureMode(platform),
        startedAt,
        async stop() {
            if (child.exitCode !== null || child.signalCode !== null) {
                return { ok: fs.existsSync(file), stderr: stderrRef.value };
            }

            // ffmpeg finalizes the container when it reads `q` from stdin. This
            // works on Windows, where Node cannot deliver SIGINT.
            child.stdin.on('error', () => {
                // The write below can fail asynchronously when ffmpeg has
                // already closed the pipe; the exit wait is the source of truth.
            });

            try {
                child.stdin.write('q\n');
            } catch {
                // The process may have already closed stdin.
            }

            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    child.kill('SIGKILL');
                    resolve();
                }, STOP_TIMEOUT_MS);
                child.once('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });

            return { ok: fs.existsSync(file), stderr: stderrRef.value };
        },
    };
}
