import path from 'path';

export function resolveE2eCargoProfile(env = process.env) {
    const profile = env.TOUCHAI_E2E_CARGO_PROFILE?.trim();
    return profile || undefined;
}

export function resolveE2eAppBinaryDirectory(env = process.env) {
    return resolveE2eCargoProfile(env) ?? 'debug';
}

export function resolveE2eAppBinaryPath(
    targetDirectory,
    platform = process.platform,
    env = process.env
) {
    return path.resolve(
        targetDirectory,
        resolveE2eAppBinaryDirectory(env),
        platform === 'win32' ? 'TouchAI.exe' : 'TouchAI'
    );
}

export function resolveTauriBuildArgs(env = process.env) {
    const args = ['tauri', 'build', '--debug', '--no-bundle'];
    const profile = resolveE2eCargoProfile(env);

    if (profile) {
        args.push('--', '--profile', profile);
    }

    return args;
}
