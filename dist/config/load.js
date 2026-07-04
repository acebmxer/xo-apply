import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { validateSpec } from './schema.js';
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
/**
 * Recursively resolve ${env:VAR} placeholders in string values.
 * Missing variables are collected and reported as one error so the user
 * can fix them all at once.
 */
export function resolveEnvRefs(value, missing, env = process.env) {
    if (typeof value === 'string') {
        return value.replace(ENV_REF, (match, name) => {
            const resolved = env[name];
            if (resolved === undefined) {
                missing.add(name);
                return match;
            }
            return resolved;
        });
    }
    if (Array.isArray(value)) {
        return value.map(v => resolveEnvRefs(v, missing, env));
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnvRefs(v, missing, env)]));
    }
    return value;
}
export function loadSpec(filePath, env = process.env) {
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
    data = resolveEnvRefs(data, missing, env);
    if (missing.size > 0) {
        throw new Error(`unresolved secret reference(s) in ${filePath}: missing environment variable(s) ${[...missing].join(', ')}`);
    }
    try {
        return validateSpec(data);
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
