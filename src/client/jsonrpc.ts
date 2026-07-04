import XoLib from 'xo-lib'

// xo-lib is Babel-compiled CommonJS: under Node ESM the import resolves to the
// module.exports object and the actual class sits on its `default` property.
type Xo = XoLib
const Xo: typeof XoLib = ((XoLib as unknown as { default?: typeof XoLib }).default ?? XoLib) as typeof XoLib

export interface JsonRpcClientOptions {
  url: string
  token: string
  insecure?: boolean
}

/**
 * Wrapper around Vates' xo-lib (the JSON-RPC websocket client used by xo-cli).
 * Used for operations the REST API does not support yet
 * (backupNg.*, schedule.*, remote.delete).
 */
export class JsonRpcClient {
  readonly #opts: JsonRpcClientOptions
  #xo: Xo | undefined

  constructor(opts: JsonRpcClientOptions) {
    this.#opts = opts
  }

  async #connect(): Promise<Xo> {
    if (this.#xo === undefined) {
      const xo = new Xo({
        url: this.#opts.url,
        rejectUnauthorized: this.#opts.insecure !== true,
      })
      await xo.open()
      try {
        await xo.signIn({ token: this.#opts.token })
      } catch (error) {
        xo.close()
        throw new Error(`XO API: JSON-RPC sign-in failed — check your token (${(error as Error).message})`)
      }
      this.#xo = xo
    }
    return this.#xo
  }

  async call(method: string, params?: unknown): Promise<any> {
    const xo = await this.#connect()
    try {
      return await xo.call(method, params ?? {})
    } catch (error) {
      const message = (error as Error).message ?? String(error)
      const data = (error as { data?: unknown }).data
      throw new Error(`XO API: ${method} failed: ${message}${data !== undefined ? ` (${JSON.stringify(data)})` : ''}`)
    }
  }

  close(): void {
    this.#xo?.close()
    this.#xo = undefined
  }
}
