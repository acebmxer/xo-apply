// XO defaults a user with no explicit permission to 'none'.
const DEFAULT_PERMISSION = 'none';
export function userSpecToDesired(spec) {
    return {
        email: spec.email,
        permission: spec.permission ?? DEFAULT_PERMISSION,
        password: spec.password,
    };
}
/**
 * A user is "local" when it is not provisioned by an external auth plugin.
 * External users carry a non-empty `authProviders` map; local users don't.
 */
export function isLocalUser(user) {
    return user.authProviders === undefined || Object.keys(user.authProviders).length === 0;
}
export function envVarNameForUser(email) {
    return `XO_USER_${email.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}_PASSWORD`;
}
/**
 * The literal password written for every local user on export. XO never
 * returns a user's real password, and `user.create` REQUIRES one, so we can't
 * omit it. We emit a known placeholder instead so the file applies out of the
 * box — operators MUST change these (or swap in `${env:...}` refs) before
 * importing into a real XO.
 */
export const EXPORT_PASSWORD_PLACEHOLDER = 'ChangeMe';
/**
 * Convert a live XO user into a spec entry. The real password can't be read
 * from XO, so a `ChangeMe` placeholder is written (see
 * EXPORT_PASSWORD_PLACEHOLDER) — every exported local user therefore applies
 * with the same known password until changed.
 */
export function userToSpec(user) {
    const spec = {
        email: user.email,
        password: EXPORT_PASSWORD_PLACEHOLDER,
    };
    if (user.permission !== undefined) {
        spec.permission = user.permission;
    }
    return { spec };
}
/**
 * Compare a desired user against the live one; empty array = in sync.
 * The password is never compared (XO does not expose it) and the email is the
 * identity key, so only `permission` can drift.
 */
export function diffUser(desired, actual) {
    const changes = [];
    const actualPermission = actual.permission ?? DEFAULT_PERMISSION;
    if (desired.permission !== actualPermission) {
        changes.push({ field: 'permission', from: actualPermission, to: desired.permission });
    }
    return changes;
}
