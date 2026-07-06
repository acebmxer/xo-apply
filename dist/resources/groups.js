export function groupSpecToDesired(spec) {
    return { name: spec.name, memberEmails: spec.users };
}
/**
 * A group is "local" when it is not synchronized from an external auth
 * provider (those carry a `provider` marker).
 */
export function isLocalGroup(group) {
    return group.provider === undefined || group.provider === null;
}
/** Map a live group's member ids to emails, falling back to the raw id. */
export function actualMemberEmails(group, userEmailById) {
    return (group.users ?? []).map(id => userEmailById.get(id) ?? id);
}
/** Convert a live XO group into a spec entry (member ids → emails). */
export function groupToSpec(group, userEmailById) {
    const spec = { name: group.name };
    const members = actualMemberEmails(group, userEmailById);
    if (members.length > 0) {
        spec.users = members;
    }
    return spec;
}
/**
 * Compare a desired group against the live one; empty array = in sync.
 * Membership is compared as an order-insensitive set of emails.
 */
export function diffGroup(desired, actual, userEmailById) {
    const changes = [];
    const desiredSet = [...new Set(desired.memberEmails)].sort();
    const actualSet = [...new Set(actualMemberEmails(actual, userEmailById))].sort();
    if (desiredSet.join('\n') !== actualSet.join('\n')) {
        changes.push({ field: 'users', from: actualSet, to: desiredSet });
    }
    return changes;
}
