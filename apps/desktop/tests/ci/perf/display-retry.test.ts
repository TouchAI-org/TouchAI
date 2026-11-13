import { describe, expect, it } from 'vitest';

import { shouldRetryDisplayStartupFailure } from '../../../scripts/perf/710/display-retry.mjs';

describe('user runs the RFC 710 performance protocol', () => {
    it('user retries once when the X11 notification stack fails before the scenario starts', () => {
        expect(
            shouldRetryDisplayStartupFailure({
                runStarted: false,
                exitCode: 1,
                signal: null,
                logText:
                    'Dunst did not register org.freedesktop.Notifications. ' +
                    "ERROR: Couldn't initialize X11 output. Aborting...",
            })
        ).toBe(true);
    });

    it('user keeps a real scenario failure visible after the app has started', () => {
        expect(
            shouldRetryDisplayStartupFailure({
                runStarted: true,
                exitCode: 1,
                signal: null,
                logText: 'The seeded 1000-message session did not finish rendering.',
            })
        ).toBe(false);
    });

    it('user does not mask an assertion failure as a display restart', () => {
        expect(
            shouldRetryDisplayStartupFailure({
                runStarted: false,
                exitCode: 1,
                signal: null,
                logText: 'AssertionError: expected the cold sample to be recorded',
            })
        ).toBe(false);
    });

    it('user does not retry an unexplained trace trap before the run starts', () => {
        expect(
            shouldRetryDisplayStartupFailure({
                runStarted: false,
                exitCode: 133,
                signal: null,
                logText: 'Trace/breakpoint trap',
            })
        ).toBe(false);
    });

    it('user gets no retry when the scenario exited cleanly', () => {
        expect(
            shouldRetryDisplayStartupFailure({
                runStarted: false,
                exitCode: 0,
                signal: null,
                logText: 'Cannot open X11 display',
            })
        ).toBe(false);
    });
});
