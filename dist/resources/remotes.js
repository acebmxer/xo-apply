import { format, parse } from 'xo-remote-parser';
import { deepEqual } from './patterns.js';
export function remoteSpecToDesired(spec) {
    const urlOptions = spec.urlOptions ?? {};
    let url;
    switch (spec.type) {
        case 'nfs':
            url = format({ type: 'nfs', host: spec.host, port: spec.port, path: spec.path, ...urlOptions });
            break;
        case 'smb':
            url = format({
                type: 'smb',
                host: spec.host,
                path: spec.path ?? '',
                domain: spec.domain,
                username: spec.username,
                password: spec.password,
                ...urlOptions,
            });
            break;
        case 's3':
            url = format({
                type: 's3',
                host: spec.host,
                path: spec.path,
                username: spec.accessKey,
                password: spec.secretKey,
                protocol: spec.protocol,
                region: spec.region,
                ...urlOptions,
            });
            break;
        case 'local':
            url = format({ type: 'file', path: spec.path, ...urlOptions });
            break;
    }
    return {
        name: spec.name,
        url,
        options: spec.type === 'nfs' ? spec.mountOptions : undefined,
        proxy: spec.proxy,
    };
}
const PARSED_CORE_FIELDS = new Set([
    'type',
    'host',
    'port',
    'path',
    'username',
    'password',
    'domain',
    'protocol',
    'region',
    'invalidUrl',
]);
function extractUrlOptions(parsed) {
    const options = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (!PARSED_CORE_FIELDS.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
            options[key] = value;
        }
    }
    return Object.keys(options).length > 0 ? options : undefined;
}
export function envVarNameForRemote(remoteName) {
    return `XO_REMOTE_${remoteName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}_SECRET`;
}
/** Convert a live XO remote into a spec entry (secrets become placeholders). */
export function remoteToSpec(remote) {
    const parsed = parse(remote.url);
    const urlOptions = extractUrlOptions(parsed);
    const base = { name: remote.name };
    if (remote.proxy != null) {
        base.proxy = remote.proxy;
    }
    switch (parsed.type) {
        case 'nfs': {
            const spec = {
                ...base,
                type: 'nfs',
                host: parsed.host,
                path: parsed.path,
            };
            if (parsed.port !== undefined) {
                spec.port = Number(parsed.port);
            }
            if (remote.options != null && remote.options !== '') {
                spec.mountOptions = remote.options;
            }
            if (urlOptions) {
                spec.urlOptions = urlOptions;
            }
            return { spec };
        }
        case 'smb': {
            const secretEnvVar = envVarNameForRemote(remote.name);
            const spec = {
                ...base,
                type: 'smb',
                host: parsed.host,
                domain: parsed.domain,
                username: parsed.username,
                password: `\${env:${secretEnvVar}}`,
            };
            if (parsed.path !== undefined && parsed.path !== '') {
                spec.path = parsed.path;
            }
            if (urlOptions) {
                spec.urlOptions = urlOptions;
            }
            return { spec, secretEnvVar };
        }
        case 's3': {
            const secretEnvVar = envVarNameForRemote(remote.name);
            const spec = {
                ...base,
                type: 's3',
                host: parsed.host,
                path: parsed.path,
                accessKey: parsed.username,
                secretKey: `\${env:${secretEnvVar}}`,
            };
            if (parsed.protocol === 'http') {
                spec.protocol = 'http';
            }
            if (parsed.region !== undefined) {
                spec.region = parsed.region;
            }
            if (urlOptions) {
                spec.urlOptions = urlOptions;
            }
            return { spec, secretEnvVar };
        }
        case 'file': {
            const spec = { ...base, type: 'local', path: parsed.path };
            if (urlOptions) {
                spec.urlOptions = urlOptions;
            }
            return { spec };
        }
        default:
            throw new Error(`remote "${remote.name}": unsupported remote type "${parsed.type}" (url: ${maskUrl(remote.url)})`);
    }
}
/** Compare a desired remote against the live one; empty array = in sync. */
export function diffRemote(desired, actual) {
    const changes = [];
    // compare parsed forms so option ordering inside the URL never causes noise
    if (!deepEqual({ ...parse(desired.url) }, { ...parse(actual.url) })) {
        changes.push({ field: 'url', from: maskUrl(actual.url), to: maskUrl(desired.url) });
    }
    const normOpt = (v) => (v == null || v === '' ? undefined : v);
    if (normOpt(desired.options) !== normOpt(actual.options)) {
        changes.push({ field: 'mountOptions', from: normOpt(actual.options), to: normOpt(desired.options) });
    }
    const normProxy = (v) => (v == null ? undefined : v);
    if (desired.proxy !== undefined && normProxy(desired.proxy) !== normProxy(actual.proxy)) {
        changes.push({ field: 'proxy', from: normProxy(actual.proxy), to: desired.proxy });
    }
    return changes;
}
/**
 * Replace any password/secret embedded in a remote URL for display.
 * Also strips the NUL separator SMB urls use so terminals render cleanly.
 */
export function maskUrl(url) {
    let masked;
    try {
        const parsed = parse(url);
        masked = parsed.password === undefined || parsed.password === '' ? url : format({ ...parsed, password: '***' });
    }
    catch {
        masked = url.replace(/:[^:@/]+@/, ':***@');
    }
    return masked.replace(/\0/g, '');
}
