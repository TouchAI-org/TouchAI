/**
 * X11 capture helpers.
 *
 * Screenshots come from the Xvfb root and are cropped to the focused window, so
 * native transparency and rounded corners are visible against a known desktop
 * colour. The video records the whole virtual display at 30 fps.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 900;
// The active window starts below the burned-in title, so the caption never
// covers the app.
export const STAGE_TOP = 64;
// picom renders the root window black on this Xvfb build even after the root
// pixmap is set, so black is the colour the capture actually shows.
export const DESKTOP_COLOUR = '#000000';

// The recorder requests 10 fps because 30 fps on a shared runner drops most
// frames and produces a video that is far shorter than the session.
export const RECORDING_FPS = 10;

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });

    if (result.error) {
        throw new Error(`${command} failed to start: ${result.error.message}`);
    }

    return result;
}

export function hasCommand(command) {
    return spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
}

export function paintDesktop(display) {
    run('xsetroot', ['-solid', DESKTOP_COLOUR], { env: { ...process.env, DISPLAY: display } });
}

/**
 * Returns the geometry of the focused window, or null when no window is focused.
 */
export function focusedWindow(display) {
    const env = { ...process.env, DISPLAY: display };
    const active = run('xdotool', ['getactivewindow'], { env });

    if (active.status !== 0) {
        return null;
    }

    const id = active.stdout.trim();

    if (!id) {
        return null;
    }

    const geometry = run('xdotool', ['getwindowgeometry', '--shell', id], { env });

    if (geometry.status !== 0) {
        return null;
    }

    const values = {};

    for (const line of geometry.stdout.split('\n')) {
        const [key, value] = line.split('=');

        if (key && value !== undefined) {
            values[key.trim()] = Number(value.trim());
        }
    }

    if (!Number.isFinite(values.WIDTH) || !Number.isFinite(values.HEIGHT)) {
        return null;
    }

    const name = run('xdotool', ['getwindowname', id], { env }).stdout.trim();

    return {
        id,
        name,
        x: values.X ?? 0,
        y: values.Y ?? 0,
        width: values.WIDTH,
        height: values.HEIGHT,
    };
}

export function windowGeometry(display, id) {
    const env = { ...process.env, DISPLAY: display };
    const geometry = run('xdotool', ['getwindowgeometry', '--shell', id], { env });

    if (geometry.status !== 0) {
        return null;
    }

    const values = {};

    for (const line of geometry.stdout.split('\n')) {
        const [key, value] = line.split('=');

        if (key && value !== undefined) {
            values[key.trim()] = Number(value.trim());
        }
    }

    if (!Number.isFinite(values.WIDTH) || !Number.isFinite(values.HEIGHT)) {
        return null;
    }

    return {
        id,
        name: run('xdotool', ['getwindowname', id], { env }).stdout.trim(),
        x: values.X ?? 0,
        y: values.Y ?? 0,
        width: values.WIDTH,
        height: values.HEIGHT,
    };
}

/**
 * Picks the visible app window for a surface.
 *
 * The search window is 750 wide and the settings window is 1120x700, so the
 * surface decides by size. This does not depend on input focus, which is not
 * reliable when the driver drives the app instead of a person.
 */
export function windowForSurface(display, surface) {
    const env = { ...process.env, DISPLAY: display };
    const listed = run('xdotool', ['search', '--onlyvisible', '--name', 'TouchAI'], { env });
    const ids = listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const candidates = ids
        .map((id) => windowGeometry(display, id))
        .filter((geometry) => geometry && geometry.width >= 300 && geometry.height >= 40);

    if (candidates.length === 0) {
        return null;
    }

    const score = (geometry) =>
        surface === 'settings'
            ? (geometry.width >= 900 && geometry.height >= 500 ? 0 : 10000) +
              Math.abs(geometry.width - 1120) +
              Math.abs(geometry.height - 700)
            : (geometry.width <= 900 ? 0 : 10000) + Math.abs(geometry.width - 750);

    return candidates.sort((left, right) => score(left) - score(right))[0];
}

export function raiseWindow(display, id) {
    const env = { ...process.env, DISPLAY: display };
    run('xdotool', ['windowraise', id], { env });
    run('xdotool', ['windowfocus', id], { env });
}

export function listAppWindows(display) {
    const env = { ...process.env, DISPLAY: display };
    const listed = run('xdotool', ['search', '--onlyvisible', '--name', 'TouchAI'], { env });

    return listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

export function moveWindow(display, id, x, y) {
    run('xdotool', ['windowmove', id, String(x), String(y)], {
        env: { ...process.env, DISPLAY: display },
    });
}

export function hideWindow(display, id) {
    run('xdotool', ['windowunmap', id], { env: { ...process.env, DISPLAY: display } });
}

export function showWindow(display, id) {
    run('xdotool', ['windowmap', id], { env: { ...process.env, DISPLAY: display } });
}

export function pngSize(file) {
    let buffer;

    try {
        const descriptor = fs.openSync(file, 'r');
        buffer = Buffer.alloc(24);
        fs.readSync(descriptor, buffer, 0, 24, 0);
        fs.closeSync(descriptor);
    } catch {
        return null;
    }

    if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
        return null;
    }

    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Crops a window screenshot to one element plus some room around it.
 *
 * The element rect is in CSS pixels and the PNG is in device pixels, so the
 * rect is scaled by the ratio between the two. A crop that would be tiny (a
 * switch, an icon) keeps a minimum size, because a control shown without the
 * label beside it tells a reviewer nothing.
 */
export function cropToElement({
    file,
    rect,
    viewport,
    padding = 48,
    minWidth = 560,
    minHeight = 340,
}) {
    const size = pngSize(file);

    if (!size || !viewport?.width || !viewport?.height) {
        return null;
    }

    const scaleX = size.width / viewport.width;
    const scaleY = size.height / viewport.height;
    const wanted = {
        width: Math.min(
            size.width,
            Math.max(minWidth, Math.round((rect.width + padding * 2) * scaleX))
        ),
        height: Math.min(
            size.height,
            Math.max(minHeight, Math.round((rect.height + padding * 2) * scaleY))
        ),
    };
    const centerX = (rect.x + rect.width / 2) * scaleX;
    const centerY = (rect.y + rect.height / 2) * scaleY;
    const x = Math.max(
        0,
        Math.min(size.width - wanted.width, Math.round(centerX - wanted.width / 2))
    );
    const y = Math.max(
        0,
        Math.min(size.height - wanted.height, Math.round(centerY - wanted.height / 2))
    );
    const scratch = `${file}.crop.png`;
    const convert = hasCommand('magick') ? 'magick' : 'convert';
    const result = run(convert, [
        file,
        '-crop',
        `${wanted.width}x${wanted.height}+${x}+${y}`,
        '+repage',
        scratch,
    ]);

    if (result.status !== 0 || !fs.existsSync(scratch)) {
        fs.rmSync(scratch, { force: true });
        return null;
    }

    fs.renameSync(scratch, file);
    return wanted;
}

/**
 * Captures one window.
 *
 * The window is captured by id rather than by cropping the root: the app
 * recenters itself when its height changes, so a geometry read a moment earlier
 * can be stale and produce a black crop.
 */
export function captureScreenshot({ display, file, geometry, id }) {
    if (id) {
        const direct = run('import', ['-window', String(id), file], {
            env: { ...process.env, DISPLAY: display },
        });

        if (direct.status === 0 && fs.existsSync(file)) {
            const size = windowGeometry(display, id);

            return {
                width: size?.width ?? 0,
                height: size?.height ?? 0,
            };
        }
    }

    const scratch = `${file}.full.png`;

    const shot = run('import', ['-window', 'root', scratch], {
        env: { ...process.env, DISPLAY: display },
    });

    if (shot.status !== 0) {
        throw new Error(`import failed: ${shot.stderr.trim()}`);
    }

    const crop = `${geometry.width}x${geometry.height}+${geometry.x}+${geometry.y}`;
    const convert = hasCommand('magick') ? 'magick' : 'convert';
    const result = run(convert, [scratch, '-crop', crop, '+repage', file]);

    fs.rmSync(scratch, { force: true });

    if (result.status !== 0) {
        throw new Error(`${convert} failed: ${result.stderr.trim()}`);
    }

    return { width: geometry.width, height: geometry.height };
}

export function startRecording({ display, file }) {
    const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'x11grab',
        '-framerate',
        String(RECORDING_FPS),
        '-thread_queue_size',
        '1024',
        '-video_size',
        `${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
        '-i',
        `${display}.0+0,0`,
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
        file,
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    return {
        child,
        async stop() {
            if (child.exitCode !== null) {
                return { ok: false, stderr };
            }

            child.kill('SIGINT');
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    child.kill('SIGKILL');
                    resolve();
                }, 8000);
                child.on('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });

            return { ok: fs.existsSync(file), stderr };
        },
    };
}

/**
 * Reads the real duration and frame count. A one-frame file is an mp4 by
 * signature but not evidence, so publishing must not treat it as a recording.
 */
export function probeVideo(file) {
    const result = run('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-count_frames',
        '-show_entries',
        'stream=nb_read_frames,avg_frame_rate,width,height',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        file,
    ]);

    if (result.status !== 0) {
        throw new Error(`ffprobe failed: ${result.stderr.trim()}`);
    }

    const payload = JSON.parse(result.stdout || '{}');
    const stream = payload.streams?.[0] ?? {};
    const durationSeconds = Number(payload.format?.duration ?? 0);
    const frames = Number(stream.nb_read_frames ?? 0);

    return {
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
        frames: Number.isFinite(frames) ? frames : 0,
        width: Number(stream.width ?? 0),
        height: Number(stream.height ?? 0),
        fps: String(stream.avg_frame_rate ?? ''),
    };
}

/**
 * Counts distinct visual states from two samples per second.
 *
 * ffmpeg's scene score misses small but real changes such as typing, so the
 * frames are downscaled and compared directly. This is what tells a recording
 * of a flow apart from a recording of one static window.
 */
export function countDistinctStates(file) {
    const width = 320;
    const height = 180;
    const result = spawnSync(
        'ffmpeg',
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            file,
            '-vf',
            `fps=2,scale=${width}:${height},format=gray`,
            '-f',
            'rawvideo',
            '-',
        ],
        { maxBuffer: 64 * 1024 * 1024 }
    );

    if (result.status !== 0 || !result.stdout) {
        return 0;
    }

    const frameSize = width * height;
    const frames = Math.floor(result.stdout.length / frameSize);
    let distinct = frames > 0 ? 1 : 0;
    let previous = result.stdout.subarray(0, frameSize);

    for (let index = 1; index < frames; index += 1) {
        const current = result.stdout.subarray(index * frameSize, (index + 1) * frameSize);
        let changed = 0;

        for (let pixel = 0; pixel < frameSize; pixel += 1) {
            if (Math.abs(current[pixel] - previous[pixel]) > 6) {
                changed += 1;
            }
        }

        // Roughly 20 changed pixels out of 57600: a typed character, a moved
        // cursor, or a new section. Ignore compression noise.
        if (changed / frameSize > 0.0003) {
            distinct += 1;
        }

        previous = current;
    }

    return distinct;
}

function assTime(ms) {
    const total = Math.max(0, Math.round(ms));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const centiseconds = Math.floor((total % 1000) / 10);

    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function assText(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/[{}]/g, '')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 160);
}

/**
 * Builds a subtitle file for the burned-in captions. Captions live outside the
 * app window so they never cover the pixels a reviewer judges.
 *
 * @param {{ title?: string, durationMs: number, steps: Array<{ startMs: number, endMs: number, text: string }> }} input
 */
export function buildAss(input) {
    const duration = Math.max(1000, Math.round(input.durationMs));
    const lines = [
        '[Script Info]',
        'ScriptType: v4.00+',
        `PlayResX: ${SCREEN_WIDTH}`,
        `PlayResY: ${SCREEN_HEIGHT}`,
        'WrapStyle: 0',
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: Title,Noto Sans CJK SC,24,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,8,24,24,26,1',
        'Style: Step,Noto Sans CJK SC,22,&H00FFFFFF,&H000000FF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,3,6,0,2,24,24,34,1',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];

    if (input.title) {
        lines.push(
            `Dialogue: 0,${assTime(0)},${assTime(duration)},Title,,0,0,0,,${assText(input.title)}`
        );
    }

    for (const step of input.steps ?? []) {
        if (!step.text || step.endMs <= step.startMs) {
            continue;
        }

        lines.push(
            `Dialogue: 0,${assTime(step.startMs)},${assTime(Math.min(step.endMs, duration))},Step,,0,0,0,,${assText(step.text)}`
        );
    }

    return `${lines.join('\n')}\n`;
}

function filterPath(file) {
    return file.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Burns the captions into a copy of the recording. Returns the output path, or
 * null when ffmpeg cannot render subtitles in this environment.
 */
export function burnCaptions({ input, output, title, durationMs, steps }) {
    const assFile = `${output}.ass`;
    fs.writeFileSync(assFile, buildAss({ title, durationMs, steps }));

    const result = run('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input,
        '-vf',
        `ass=${filterPath(assFile)}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        output,
    ]);

    if (result.status !== 0) {
        console.log(`could not burn captions: ${result.stderr.slice(0, 500)}`);
        fs.rmSync(assFile, { force: true });
        return null;
    }

    fs.rmSync(assFile, { force: true });
    return output;
}

export function ensureDir(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return path.resolve(directory);
}
