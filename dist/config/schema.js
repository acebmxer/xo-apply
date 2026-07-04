import { z } from 'zod';
// ---------------------------------------------------------------------------
// Remotes (backup repositories)
// ---------------------------------------------------------------------------
const remoteBase = {
    name: z.string().min(1),
    // XO proxy id to access this remote through (optional, advanced)
    proxy: z.string().optional(),
    // extra URL query options understood by @xen-orchestra/fs
    // (e.g. useVhdDirectory, compressionType). Values are JSON-encoded by XO.
    urlOptions: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
};
const nfsRemote = z
    .object({
    ...remoteBase,
    type: z.literal('nfs'),
    host: z.string().min(1),
    port: z.number().int().optional(),
    path: z.string().min(1),
    // mount options string passed to mount(8), e.g. "vers=4"
    mountOptions: z.string().optional(),
})
    .strict();
const smbRemote = z
    .object({
    ...remoteBase,
    type: z.literal('smb'),
    // "HOST\\share" as shown in the XO UI, e.g. "192.168.1.50\\backups"
    host: z.string().min(1),
    // optional subfolder inside the share
    path: z.string().optional(),
    domain: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
})
    .strict();
const s3Remote = z
    .object({
    ...remoteBase,
    type: z.literal('s3'),
    // endpoint host, e.g. "s3.us-east-1.amazonaws.com" or "minio.lan:9000"
    host: z.string().min(1),
    // "bucket/directory"
    path: z.string().min(1),
    accessKey: z.string().min(1),
    secretKey: z.string().min(1),
    region: z.string().optional(),
    protocol: z.enum(['https', 'http']).default('https'),
})
    .strict();
const localRemote = z
    .object({
    ...remoteBase,
    type: z.literal('local'),
    path: z.string().min(1),
})
    .strict();
export const remoteSpecSchema = z.discriminatedUnion('type', [nfsRemote, smbRemote, s3Remote, localRemote]);
// ---------------------------------------------------------------------------
// Backup jobs + schedules
// ---------------------------------------------------------------------------
export const scheduleSpecSchema = z
    .object({
    name: z.string().min(1),
    cron: z.string().min(1),
    enabled: z.boolean().default(true),
    timezone: z.string().optional(),
    // number of backups kept on the remotes (XO: exportRetention)
    retention: z.number().int().min(0).optional(),
    // number of snapshots kept on the pool (XO: snapshotRetention)
    snapshotRetention: z.number().int().min(0).optional(),
})
    .strict();
const vmsSelector = z
    .object({
    // smart mode: all VMs carrying one of these tags
    tag: z.string().optional(),
    tags: z.array(z.string()).nonempty().optional(),
    // explicit selection, resolved to UUIDs at apply time
    names: z.array(z.string()).nonempty().optional(),
    uuids: z.array(z.string()).nonempty().optional(),
    // escape hatch: a raw XO smart-mode pattern, passed through untouched
    raw: z.record(z.unknown()).optional(),
})
    .strict()
    .refine(v => [v.tag ?? v.tags, v.names, v.uuids, v.raw].filter(x => x !== undefined).length === 1, { message: 'vms must use exactly one selector: tag/tags, names, uuids or raw' });
export const backupJobSpecSchema = z
    .object({
    name: z.string().min(1),
    mode: z.enum(['full', 'delta']),
    // only meaningful for mode: full; XO rejects it otherwise
    compression: z.enum(['native', 'zstd']).optional(),
    vms: vmsSelector,
    // remote names (defined in the remotes section or already existing in XO)
    remotes: z.array(z.string()).default([]),
    // free-form global job settings merged into XO's settings[''] —
    // e.g. concurrency, timezone, maxExportRate, nRetriesVmBackupFailures, reportWhen
    settings: z.record(z.unknown()).default({}),
    schedules: z.array(scheduleSpecSchema).default([]),
})
    .strict();
// ---------------------------------------------------------------------------
// Top-level spec
// ---------------------------------------------------------------------------
// A section that is absent from the file is UNMANAGED: xo-apply ignores that
// resource type entirely (no drift reports, never pruned). A present-but-empty
// section means "I manage this type and want none of them".
export const specSchema = z
    .object({
    remotes: z.array(remoteSpecSchema).optional(),
    backupJobs: z.array(backupJobSpecSchema).optional(),
})
    .strict();
export function validateSpec(data) {
    const spec = specSchema.parse(data);
    const dupes = (names) => names.filter((n, i) => names.indexOf(n) !== i);
    const remoteDupes = dupes((spec.remotes ?? []).map(r => r.name));
    if (remoteDupes.length > 0) {
        throw new Error(`duplicate remote name(s): ${[...new Set(remoteDupes)].join(', ')}`);
    }
    const jobDupes = dupes((spec.backupJobs ?? []).map(j => j.name));
    if (jobDupes.length > 0) {
        throw new Error(`duplicate backup job name(s): ${[...new Set(jobDupes)].join(', ')}`);
    }
    for (const job of spec.backupJobs ?? []) {
        const schedDupes = dupes(job.schedules.map(s => s.name));
        if (schedDupes.length > 0) {
            throw new Error(`backup job "${job.name}": duplicate schedule name(s): ${[...new Set(schedDupes)].join(', ')}`);
        }
    }
    return spec;
}
