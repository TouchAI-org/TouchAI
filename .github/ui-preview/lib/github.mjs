/**
 * Minimal GitHub REST client.
 *
 * Every call is explicit about its token: the upload token and the App token are
 * never interchangeable, and nothing falls back to another credential.
 */

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

export class GitHubError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'GitHubError';
        this.status = status;
        this.body = body;
    }
}

function headers(token, extra = {}) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'touchai-ui-preview',
        ...extra,
    };
}

function responseMessage(text) {
    try {
        const parsed = JSON.parse(text);
        return [parsed?.message, parsed?.documentation_url].filter(Boolean).join(' ');
    } catch {
        return String(text ?? '')
            .trim()
            .slice(0, 300);
    }
}

async function request(url, { token, method = 'GET', body, accept, contentType } = {}) {
    const response = await fetch(url, {
        method,
        headers: headers(token, {
            ...(accept ? { Accept: accept } : {}),
            ...(contentType ? { 'Content-Type': contentType } : {}),
        }),
        body,
    });

    const text = await response.text();

    if (!response.ok) {
        throw new GitHubError(
            `${method} ${url.replace(API, '')} failed with ${response.status}`,
            response.status,
            text.slice(0, 500)
        );
    }

    return text ? JSON.parse(text) : null;
}

/**
 * Installation tokens cannot call GET /user, so the workflow passes the App
 * slug it just minted. The fallback keeps local user-token runs working.
 */
export async function resolveBotLogin(client, configuredLogin = '') {
    const login = String(configuredLogin ?? '').trim();

    if (login) {
        return login;
    }

    const user = await client.getAuthenticatedUser();
    return user?.login ?? '';
}

export function createClient({ token, owner, repo }) {
    const repoPath = `/repos/${owner}/${repo}`;

    return {
        async getAuthenticatedUser() {
            return request(`${API}/user`, { token });
        },

        async getPullRequest(number) {
            return request(`${API}${repoPath}/pulls/${number}`, { token });
        },

        async listPullRequestFiles(number) {
            const files = [];

            for (let page = 1; page <= 30; page += 1) {
                const batch = await request(
                    `${API}${repoPath}/pulls/${number}/files?per_page=100&page=${page}`,
                    { token }
                );
                files.push(...batch);

                if (batch.length < 100) {
                    break;
                }
            }

            return files;
        },

        async getPermission(login) {
            try {
                const result = await request(
                    `${API}${repoPath}/collaborators/${encodeURIComponent(login)}/permission`,
                    { token }
                );
                return result?.permission ?? 'none';
            } catch (error) {
                if (error instanceof GitHubError && error.status === 404) {
                    return 'none';
                }

                throw error;
            }
        },

        async listComments(number) {
            const comments = [];

            for (let page = 1; page <= 20; page += 1) {
                const batch = await request(
                    `${API}${repoPath}/issues/${number}/comments?per_page=100&page=${page}`,
                    { token }
                );
                comments.push(...batch);

                if (batch.length < 100) {
                    break;
                }
            }

            return comments;
        },

        async createComment(number, body) {
            return request(`${API}${repoPath}/issues/${number}/comments`, {
                token,
                method: 'POST',
                body: JSON.stringify({ body }),
                contentType: 'application/json',
            });
        },

        async updateComment(commentId, body) {
            return request(`${API}${repoPath}/issues/comments/${commentId}`, {
                token,
                method: 'PATCH',
                body: JSON.stringify({ body }),
                contentType: 'application/json',
            });
        },

        async addLabels(number, labels) {
            return request(`${API}${repoPath}/issues/${number}/labels`, {
                token,
                method: 'POST',
                body: JSON.stringify({ labels }),
                contentType: 'application/json',
            });
        },

        async removeLabel(number, label) {
            return request(
                `${API}${repoPath}/issues/${number}/labels/${encodeURIComponent(label)}`,
                { token, method: 'DELETE' }
            );
        },

        async getIssueLabels(number) {
            const issue = await request(`${API}${repoPath}/issues/${number}`, { token });
            return (issue?.labels ?? []).map((label) =>
                typeof label === 'string' ? label : label.name
            );
        },

        async compareFiles(base, head) {
            const comparison = await request(
                `${API}${repoPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`,
                { token }
            );
            return comparison?.files ?? [];
        },

        async getDiff(number) {
            const response = await fetch(`${API}${repoPath}/pulls/${number}`, {
                headers: headers(token, { Accept: 'application/vnd.github.diff' }),
            });

            if (!response.ok) {
                throw new GitHubError(
                    `GET pull request diff failed with ${response.status}`,
                    response.status,
                    (await response.text()).slice(0, 500)
                );
            }

            return response.text();
        },

        /**
         * Uploads one asset with a user credential. GitHub App installation tokens
         * and App user-to-server tokens are rejected by this endpoint with 404, so a
         * failure here must name the credential class instead of looking like a
         * transient error.
         */
        async uploadAsset({ token: uploadToken, name, contentType, data, repositoryId }) {
            const url = new URL(`${UPLOADS}/user-attachments/assets`);
            url.searchParams.set('name', name);
            url.searchParams.set('content_type', contentType);
            url.searchParams.set('repository_id', String(repositoryId));

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `token ${uploadToken}`,
                    'Content-Type': 'application/octet-stream',
                    'User-Agent': 'touchai-ui-preview',
                },
                body: data,
            });

            const text = await response.text();

            if (!response.ok) {
                const hint =
                    response.status === 404
                        ? ' The upload endpoint rejects installation and App user tokens; ATTACHMENT_TOKEN must belong to a user with write access.'
                        : response.status === 403
                          ? ' The upload credential cannot write attachments to this repository. Check the token owner, repository access, and Contents write permission.'
                          : '';
                const detail = responseMessage(text);
                throw new GitHubError(
                    `upload of ${name} failed with ${response.status}.${hint}${detail ? ` ${detail}` : ''}`,
                    response.status,
                    text.slice(0, 500)
                );
            }

            const parsed = JSON.parse(text);
            return parsed.url;
        },
    };
}
