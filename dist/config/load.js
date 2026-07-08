import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { validateSpec } from './schema.js';
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
/**
 * Recursively resolve ${env:VAR} placeholders in string values.
 * Missing variables are collected in `missing` so the caller can react.
 *
 * `dropUnresolved` controls what happens to a string that still contains an
 * unresolved reference after substitution:
 *   - false (default): the literal `${env:VAR}` is left in place. The caller is
 *     expected to treat a non-empty `missing` set as a hard error.
 *   - true: the whole string is replaced with `undefined` (so the containing
 *     object key is dropped). Used by read-only commands (diff/dry-run) that
 *     never need the secret's value — a resolved-away password simply becomes
 *     "no password", which is ignored by diff and fails safe on apply-create.
 */
export function resolveEnvRefs(value, missing, env = process.env, dropUnresolved = false) {
    if (typeof value === 'string') {
        let sawMissing = false;
        const replaced = value.replace(ENV_REF, (match, name) => {
            const resolved = env[name];
            if (resolved === undefined) {
                missing.add(name);
                sawMissing = true;
                return match;
            }
            return resolved;
        });
        if (sawMissing && dropUnresolved)
            return undefined;
        return replaced;
    }
    if (Array.isArray(value)) {
        return value.map(v => resolveEnvRefs(v, missing, env, dropUnresolved));
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .map(([k, v]) => [k, resolveEnvRefs(v, missing, env, dropUnresolved)])
            // drop keys whose value resolved away to undefined
            .filter(([, v]) => v !== undefined));
    }
    return value;
}
/**
 * Load, resolve secrets in, and validate a config file. Throws on a missing
 * secret unless `allowMissingSecrets` is set. Prefer `loadSpec` for the common
 * "must resolve everything" case; use this when you need the missing set back.
 */
export function loadSpecResult(filePath, options = {}) {
    const env = options.env ?? process.env;
    let raw;
    try {
        raw = readFileSync(filePath, 'utf8');
    }
    catch (error) {
        throw new Error(`cannot read config file ${filePath}: ${error.message}`);
    }
    let data;
    try {
        data = parseYaml(raw);
    }
    catch (error) {
        throw new Error(`invalid YAML in ${filePath}: ${error.message}`);
    }
    if (data === null || data === undefined) {
        throw new Error(`${filePath} is empty`);
    }
    const missing = new Set();
    data = resolveEnvRefs(data, missing, env, options.allowMissingSecrets === true);
    if (missing.size > 0 && options.allowMissingSecrets !== true) {
        throw new Error(`unresolved secret reference(s) in ${filePath}: missing environment variable(s) ${[...missing].join(', ')}`);
    }
    try {
        return { spec: validateSpec(data), missingSecrets: [...missing] };
    }
    catch (error) {
        if (error instanceof ZodError) {
            const details = error.issues
                .map(issue => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('\n');
            throw new Error(`invalid config in ${filePath}:\n${details}`);
        }
        throw error;
    }
}
export function loadSpec(filePath, env = process.env) {
    return loadSpecResult(filePath, { env }).spec;
}
