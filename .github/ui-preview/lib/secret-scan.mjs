/**
 * Refuses to publish evidence that contains something shaped like a credential.
 *
 * The recording job holds no secret by design, so this is a last line rather
 * than the only one: a key pasted into a pull request description, a fixture,
 * or a model summary would otherwise end up in a public comment.
 */

const PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function findSecret(text) {
    const value = String(text ?? '');

    for (const pattern of PATTERNS) {
        const match = pattern.exec(value);

        if (match) {
            return { kind: pattern.source, sample: `${match[0].slice(0, 6)}...` };
        }
    }

    return null;
}
