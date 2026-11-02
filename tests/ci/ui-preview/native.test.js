import { describe, expect, it } from 'vitest';

import {
    buildCropFilter,
    buildRecordingArgs,
    parseDisplaySize,
    recordingFps,
} from '../../../.github/ui-preview/lib/native-capture.mjs';
import {
    captureMode,
    detectPlatform,
    ffmpegBinary,
    ffprobeBinary,
    isUsableDisplay,
    platformLabel,
} from '../../../.github/ui-preview/lib/platform.mjs';
import { resolveCaptureProfile } from '../../../.github/ui-preview/lib/profile.mjs';
import { bridge } from '../../../.github/ui-preview/lib/runtime.mjs';

describe('user records the preview on a native desktop', () => {
    it('user gets the ffmpeg build the workflow selected', () => {
        expect(ffmpegBinary({})).toBe('ffmpeg');
        expect(ffprobeBinary({})).toBe('ffprobe');
        expect(ffmpegBinary({ UI_PREVIEW_FFMPEG: '/opt/ffmpeg7/bin/ffmpeg' })).toBe(
            '/opt/ffmpeg7/bin/ffmpeg'
        );
        expect(ffprobeBinary({ UI_PREVIEW_FFPROBE: '/opt/ffmpeg7/bin/ffprobe' })).toBe(
            '/opt/ffmpeg7/bin/ffprobe'
        );
    });

    it('user gets the platform name from the runner operating system', () => {
        expect(detectPlatform('darwin')).toBe('macos');
        expect(detectPlatform('win32')).toBe('windows');
        expect(detectPlatform('linux')).toBe('linux');
        expect(detectPlatform('macos')).toBe('macos');
        expect(detectPlatform('windows')).toBe('windows');
    });

    it('user gets a readable platform label and capture mode', () => {
        expect(platformLabel('linux')).toBe('Linux');
        expect(platformLabel('macos')).toBe('macOS');
        expect(platformLabel('windows')).toBe('Windows');
        expect(captureMode('linux')).toBe('x11grab');
        expect(captureMode('macos')).toBe('avfoundation');
        expect(captureMode('windows')).toBe('gdigrab');
    });

    it('user gets a clear display failure when the hosted screen is too small', () => {
        expect(isUsableDisplay(1280, 900)).toBe(true);
        expect(isUsableDisplay(1920, 1080)).toBe(true);
        expect(isUsableDisplay(1176, 694)).toBe(false);
        expect(isUsableDisplay(1024, 768)).toBe(false);
    });
});

describe('user records with the platform capture device', () => {
    it('user gets x11grab for the Linux virtual display', () => {
        const args = buildRecordingArgs({
            platform: 'linux',
            display: ':99',
            width: 1280,
            height: 900,
            file: 'recording.mp4',
        });

        expect(args).toContain('x11grab');
        expect(args).toContain(':99.0+0,0');
        expect(args).toContain('1280x900');
        expect(args).toContain('10');
        expect(args).toContain('-draw_mouse');
        expect(args[args.indexOf('-draw_mouse') + 1]).toBe('0');
        expect(args).toContain('recording.mp4');
    });

    it('user gets avfoundation for the macOS screen', () => {
        const args = buildRecordingArgs({
            platform: 'macos',
            width: 1920,
            height: 1080,
            file: 'recording.mp4',
        });

        expect(args).toContain('avfoundation');
        expect(args).toContain('Capture screen 0:none');
        expect(args).toContain('uyvy422');
        expect(args).toContain('1920x1080');
        expect(args).toContain('-capture_cursor');
        expect(args[args.indexOf('-capture_cursor') + 1]).toBe('0');
        expect(recordingFps('macos')).toBe(30);
    });

    it('user gets gdigrab for the Windows desktop', () => {
        const args = buildRecordingArgs({
            platform: 'windows',
            width: 1920,
            height: 1080,
            file: 'recording.mp4',
        });

        expect(args).toContain('gdigrab');
        expect(args).toContain('desktop');
        expect(args).toContain('-draw_mouse');
        expect(args[args.indexOf('-draw_mouse') + 1]).toBe('0');
        expect(recordingFps('windows')).toBe(10);
    });

    it('user gets a constant 30 fps output on every platform', () => {
        for (const platform of ['linux', 'macos', 'windows']) {
            const args = buildRecordingArgs({
                platform,
                width: 1920,
                height: 1080,
                file: 'recording.mp4',
            });
            const outputRate = args[args.indexOf('-r') + 1];

            expect(outputRate).toBe('30');
            expect(args).toContain('cfr');
        }
    });
});

describe('user drives the preview bridge without the Windows async transport', () => {
    it('user gets a synchronous bridge call and waits for its result', async () => {
        const calls = [];
        const session = {
            async execute(script, args) {
                calls.push({ script, args });

                if (calls.length === 1) {
                    return { ok: true, id: 'bridge-1' };
                }

                return { id: 'bridge-1', status: 'done', error: '' };
            },
            async executeAsync() {
                throw new Error('the Windows async transport must not be used');
            },
        };

        await expect(bridge(session, 'setSearchQuery', ['touchai'])).resolves.toBeUndefined();

        expect(calls).toHaveLength(2);
        expect(calls[0].script).toContain('window.__TOUCHAI_E2E__');
        expect(calls[0].script).not.toContain('arguments[arguments.length - 1]');
        expect(calls[0].args).toEqual(['setSearchQuery', ['touchai']]);
        expect(calls[1].script).toContain('window.__UI_PREVIEW_BRIDGE_STATE__');
        expect(calls[1].script).not.toContain('arguments[arguments.length - 1]');
    });

    it('user gets the bridge error instead of a silent failure', async () => {
        let calls = 0;
        const session = {
            async execute() {
                calls += 1;

                if (calls === 1) {
                    return { ok: true, id: 'bridge-1' };
                }

                return { id: 'bridge-1', status: 'error', error: 'settings failed' };
            },
        };

        await expect(bridge(session, 'openSettingsWindow')).rejects.toThrow('settings failed');
    });
});

describe('user gets the same preview stage from a larger desktop', () => {
    it('user gets a top-left crop when the hosted display is larger', () => {
        const stage = { width: 2560, height: 1600 };

        expect(buildCropFilter(3840, 2160, stage)).toBe('crop=2560:1600:0:0');
        expect(buildCropFilter(2560, 1800, stage)).toBe('crop=2560:1600:0:0');
    });

    it('user gets no crop when the display is already the stage size', () => {
        const stage = { width: 2560, height: 1600 };

        expect(buildCropFilter(2560, 1600, stage)).toBeNull();
        expect(buildCropFilter(2560, 1800, stage)).toBe('crop=2560:1600:0:0');
    });

    it('user gets the display size exported by the workflow', () => {
        expect(
            parseDisplaySize(
                {
                    UI_PREVIEW_DISPLAY_WIDTH: '1920',
                    UI_PREVIEW_DISPLAY_HEIGHT: '1080',
                },
                'macos'
            )
        ).toEqual({ width: 1920, height: 1080 });
        expect(parseDisplaySize({}, 'linux')).toEqual({ width: 1280, height: 900 });
        expect(parseDisplaySize({}, 'windows')).toEqual({ width: 0, height: 0 });
    });

    it('user gets a 2x physical stage without changing the logical layout', () => {
        const profile = resolveCaptureProfile({
            UI_PREVIEW_STAGE_WIDTH: '1280',
            UI_PREVIEW_STAGE_HEIGHT: '800',
            UI_PREVIEW_STAGE_TOP: '40',
            UI_PREVIEW_SCALE_FACTOR: '2',
        });

        expect(profile.stage).toEqual({ width: 1280, height: 800, top: 40 });
        expect(profile.scale).toBe(2);
        expect(profile.physical).toEqual({ width: 2560, height: 1600, top: 80 });
        expect(parseDisplaySize({}, 'linux', profile)).toEqual({ width: 2560, height: 1600 });
    });
});
