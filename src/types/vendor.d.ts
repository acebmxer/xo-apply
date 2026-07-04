declare module 'xo-lib' {
  export class XoError extends Error {}

  export default class Xo {
    constructor(opts?: {
      url?: string
      credentials?: unknown
      rejectUnauthorized?: boolean
      [key: string]: unknown
    })
    open(): Promise<void>
    close(): void
    call(method: string, params?: unknown): Promise<any>
    signIn(credentials: { token: string } | { email: string; password: string }): Promise<void>
    readonly user: unknown
  }
}

declare module 'xo-remote-parser' {
  export interface ParsedRemote {
    type: string
    host?: string
    port?: string | number
    path?: string
    username?: string
    password?: string
    domain?: string
    protocol?: string
    region?: string
    invalidUrl?: boolean
    // remaining keys are URL query options (JSON-decoded values)
    [key: string]: unknown
  }

  export function parse(url: string): ParsedRemote
  export function format(remote: {
    type: string
    host?: string
    port?: string | number
    path?: string
    username?: string
    password?: string
    domain?: string
    protocol?: string
    region?: string
    [key: string]: unknown
  }): string
}
