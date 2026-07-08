import { readFileSync } from 'node:fs';
/**
 * Minimal .env loader. Reads KEY=value lines from `path` and populates
 * `process.env` — but only for keys that are NOT already set, so a real shell
 * environment variable always wins over the file. This gives the precedence
 * "use the env var if supplied, otherwise fall back to .env".
 *
 * Supported syntax (a deliberate subset — no dependency):
 *   - `KEY=value` and `export KEY=value`
 *   - blank lines and `#` comments
 *   - single- or double-quoted values (quotes stripped; inner quotes kept as-is)
 *   - inline `# comment` after an UNquoted value
 *
 * Returns the list of keys it set (for optional logging); silently does nothing
 * if the file does not exist.
 */
export function loadDotenv(path = '.env', env = process.env) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw new Error(`cannot read env file ${path}: ${error.message}`);
    }
    const applied = [];
    for (const parsed of parseDotenv(raw)) {
        // real environment wins; only fill gaps from the file
        if (env[parsed.key] === undefined) {
            env[parsed.key] = parsed.value;
            applied.push(parsed.key);
        }
    }
    return applied;
}
/** Parse .env text into key/value entries. Exported for testing. */
export function parseDotenv(raw) {
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#'))
            continue;
        const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
        const eq = withoutExport.indexOf('=');
        if (eq === -1)
            continue;
        const key = withoutExport.slice(0, eq).trim();
        if (key === '' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            continue;
        let value = withoutExport.slice(eq + 1).trim();
        const quote = value[0];
        if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
            // quoted: strip the surrounding quotes, keep contents verbatim
            value = value.slice(1, -1);
        }
        else {
            // unquoted: an inline "# comment" ends the value
            const hash = value.indexOf(' #');
            if (hash !== -1)
                value = value.slice(0, hash).trim();
        }
        entries.push({ key, value });
    }
    return entries;
}
