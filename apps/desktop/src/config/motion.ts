// Copyright (c) 2026. 千诚. Licensed under GPL v3
export const ANIMATION_SPEEDS = { slower: 1.2, standard: 1, faster: 0.65 } as const;
export type AnimationSpeed = keyof typeof ANIMATION_SPEEDS;

export function normalizeAnimationSpeed(value: unknown): AnimationSpeed {
    return value === 'slower' || value === 'standard' || value === 'faster' ? value : 'standard';
}

export function resolveMotionDuration(
    milliseconds: number,
    speed: AnimationSpeed,
    reduced: boolean
): number {
    return reduced ? 0 : milliseconds * ANIMATION_SPEEDS[speed];
}
