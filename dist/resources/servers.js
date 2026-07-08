export function serverSpecToDesired(spec) {
    return {
        host: spec.host,
        username: spec.username,
        label: spec.label,
        allowUnauthorized: spec.allowUnauthorized,
        enabled: spec.enabled,
        password: spec.password,
    };
}
export function envVarNameForServer(host) {
    return `XO_SERVER_${host.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}_PASSWORD`;
}
/**
 * Convert a live XO server into a spec entry. XO never returns the connection
 * password, so a `${env:...}` placeholder is written — operators MUST set that
 * environment variable before importing into a real XO. Fields at their default
 * (allowUnauthorized=false, enabled=true, no label) are omitted for a clean file.
 */
export function serverToSpec(server) {
    const secretEnvVar = envVarNameForServer(server.host);
    const spec = {
        host: server.host,
        username: server.username,
        password: `\${env:${secretEnvVar}}`,
    };
    if (server.label !== undefined && server.label !== '') {
        spec.label = server.label;
    }
    if (server.allowUnauthorized === true) {
        spec.allowUnauthorized = true;
    }
    if (server.enabled === false) {
        spec.enabled = false;
    }
    return { spec, secretEnvVar };
}
/**
 * Compare a desired server against the live one; empty array = in sync.
 * The password is never compared (XO does not expose it) and `host` is the
 * identity key, so only label/username/allowUnauthorized/enabled can drift.
 */
export function diffServer(desired, actual) {
    const changes = [];
    const normLabel = (v) => (v === undefined || v === '' ? undefined : v);
    if (normLabel(desired.label) !== normLabel(actual.label)) {
        changes.push({ field: 'label', from: normLabel(actual.label), to: normLabel(desired.label) });
    }
    if (desired.username !== actual.username) {
        changes.push({ field: 'username', from: actual.username, to: desired.username });
    }
    const actualAllow = actual.allowUnauthorized ?? false;
    if (desired.allowUnauthorized !== actualAllow) {
        changes.push({ field: 'allowUnauthorized', from: actualAllow, to: desired.allowUnauthorized });
    }
    const actualEnabled = actual.enabled ?? false;
    if (desired.enabled !== actualEnabled) {
        changes.push({ field: 'enabled', from: actualEnabled, to: desired.enabled });
    }
    return changes;
}
