/**
 * Minimal client for XO's REST API (/rest/v0).
 * https://docs.xen-orchestra.com/restapi
 */
export class RestClient {
    #base;
    #token;
    constructor({ url, token }) {
        this.#base = `${url.replace(/\/+$/, '')}/rest/v0`;
        this.#token = token;
    }
    async #request(method, path, query, body) {
        const url = new URL(this.#base + path);
        if (query !== undefined) {
            for (const [key, value] of Object.entries(query)) {
                url.searchParams.set(key, value);
            }
        }
        const response = await fetch(url, {
            method,
            headers: {
                cookie: `authenticationToken=${this.#token}`,
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            if (response.status === 401) {
                throw new Error(`XO API: authentication failed (401) — check your token`);
            }
            throw new Error(`XO API: ${method} ${path} failed with ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
        }
        if (response.status === 204) {
            return undefined;
        }
        const text = await response.text();
        return text === '' ? undefined : JSON.parse(text);
    }
    get(path, query) {
        return this.#request('GET', path, query);
    }
    post(path, body) {
        return this.#request('POST', path, undefined, body);
    }
    patch(path, body) {
        return this.#request('PATCH', path, undefined, body);
    }
    delete(path) {
        return this.#request('DELETE', path);
    }
}
