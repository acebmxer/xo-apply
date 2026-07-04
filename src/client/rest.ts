export interface RestClientOptions {
  /** base XO URL, e.g. https://xo.example.lan */
  url: string
  token: string
}

/**
 * Minimal client for XO's REST API (/rest/v0).
 * https://docs.xen-orchestra.com/restapi
 */
export class RestClient {
  readonly #base: string
  readonly #token: string

  constructor({ url, token }: RestClientOptions) {
    this.#base = `${url.replace(/\/+$/, '')}/rest/v0`
    this.#token = token
  }

  async #request(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<unknown> {
    const url = new URL(this.#base + path)
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value)
      }
    }
    const response = await fetch(url, {
      method,
      headers: {
        cookie: `authenticationToken=${this.#token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401) {
        throw new Error(`XO API: authentication failed (401) — check your token`)
      }
      throw new Error(`XO API: ${method} ${path} failed with ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`)
    }
    if (response.status === 204) {
      return undefined
    }
    const text = await response.text()
    return text === '' ? undefined : JSON.parse(text)
  }

  get(path: string, query?: Record<string, string>): Promise<any> {
    return this.#request('GET', path, query)
  }

  post(path: string, body?: unknown): Promise<any> {
    return this.#request('POST', path, undefined, body)
  }

  patch(path: string, body?: unknown): Promise<any> {
    return this.#request('PATCH', path, undefined, body)
  }

  delete(path: string): Promise<any> {
    return this.#request('DELETE', path)
  }
}
