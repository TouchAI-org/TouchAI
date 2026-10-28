/**
 * Minimums a recording must meet to count as evidence.
 *
 * A file can be a valid mp4 and still be one frame. These values are shared by
 * the recorder, which reports them, and the publisher, which enforces them.
 */
export const MIN_VIDEO_SECONDS = 6;
export const MIN_VIDEO_FRAMES = 60;
export const MIN_DISTINCT_STATES = 5;
export const MIN_COVERAGE = 0.8;
