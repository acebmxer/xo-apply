import XoLib from 'xo-lib';
const Xo = (XoLib.default ?? XoLib);
/**
 * Wrapper around Vates' xo-lib (the JSON-RPC websocket client used by xo-cli).
 * Used for operations the REST API does not support yet
 * (backupNg.*, schedule.*, remote.delete).
 */
export class JsonRpcClient {
    #opts;
    #xo;
    constructor(opts) {
        this.#opts = opts;
    }
    async #connect() {
        if (this.#xo === undefined) {
            const xo = new Xo({
                url: this.#opts.url,
                rejectUnauthorized: this.#opts.insecure !== true,
            });
            await xo.open();
            try {
                await xo.signIn({ token: this.#opts.token });
            }
            catch (error) {
                xo.close();
                throw new Error(`XO API: JSON-RPC sign-in failed — check your token (${error.message})`);
            }
            this.#xo = xo;
        }
        return this.#xo;
    }
    async call(method, params) {
        const xo = await this.#connect();
        try {
            return await xo.call(method, params ?? {});
        }
        catch (error) {
            const message = error.message ?? String(error);
            const data = error.data;
            throw new Error(`XO API: ${method} failed: ${message}${data !== undefined ? ` (${JSON.stringify(data)})` : ''}`);
        }
    }
    close() {
        this.#xo?.close();
        this.#xo = undefined;
    }
}
