import { z } from 'zod'

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
}

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
  .strict()

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
  .strict()

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
  .strict()

const localRemote = z
  .object({
    ...remoteBase,
    type: z.literal('local'),
    path: z.string().min(1),
  })
  .strict()

export const remoteSpecSchema = z.discriminatedUnion('type', [nfsRemote, smbRemote, s3Remote, localRemote])
export type RemoteSpec = z.infer<typeof remoteSpecSchema>

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
    // any other per-schedule XO settings, passed through verbatim
    // (e.g. fullInterval for "force full backup", health check options)
    settings: z.record(z.unknown()).default({}),
  })
  .strict()
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>

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
  .refine(
    v => [v.tag ?? v.tags, v.names, v.uuids, v.raw].filter(x => x !== undefined).length === 1,
    { message: 'vms must use exactly one selector: tag/tags, names, uuids or raw' }
  )
export type VmsSelector = z.infer<typeof vmsSelector>

export const backupJobSpecSchema = z
  .object({
    name: z.string().min(1),
    // full/delta VM backup to a remote; with `srs` this is DR (full) or CR (delta)
    mode: z.enum(['full', 'delta']),
    // only meaningful for mode: full; XO rejects it otherwise
    compression: z.enum(['native', 'zstd']).optional(),
    vms: vmsSelector,
    // remote names (defined in the remotes section or already existing in XO)
    remotes: z.array(z.string()).default([]),
    // target SR UUIDs — turns this into a replication job (DR when mode:full,
    // Continuous Replication when mode:delta). May be combined with remotes.
    srs: z.array(z.string()).default([]),
    // free-form global job settings merged into XO's settings[''] —
    // e.g. concurrency, timezone, maxExportRate, nRetriesVmBackupFailures, reportWhen
    settings: z.record(z.unknown()).default({}),
    schedules: z.array(scheduleSpecSchema).default([]),
  })
  .strict()
  .refine(v => v.remotes.length > 0 || v.srs.length > 0, {
    message: 'backup job must target at least one remote or SR',
  })
export type BackupJobSpec = z.infer<typeof backupJobSpecSchema>

// ---------------------------------------------------------------------------
// Metadata backup jobs (pool metadata + XO config)
// ---------------------------------------------------------------------------

export const metadataScheduleSpecSchema = z
  .object({
    name: z.string().min(1),
    cron: z.string().min(1),
    enabled: z.boolean().default(true),
    timezone: z.string().optional(),
    // XO: retentionPoolMetadata / retentionXoMetadata
    poolRetention: z.number().int().min(0).optional(),
    xoRetention: z.number().int().min(0).optional(),
    settings: z.record(z.unknown()).default({}),
  })
  .strict()
export type MetadataScheduleSpec = z.infer<typeof metadataScheduleSpecSchema>

export const metadataBackupSpecSchema = z
  .object({
    name: z.string().min(1),
    // back up XO's own configuration
    xoMetadata: z.boolean().default(false),
    // pool UUIDs whose metadata to back up (pool metadata backup)
    pools: z.array(z.string()).default([]),
    remotes: z.array(z.string()).default([]),
    settings: z.record(z.unknown()).default({}),
    schedules: z.array(metadataScheduleSpecSchema).default([]),
  })
  .strict()
  .refine(v => v.xoMetadata || v.pools.length > 0, {
    message: 'metadata backup must set xoMetadata: true or list one or more pools',
  })
  .refine(v => v.remotes.length > 0, { message: 'metadata backup must target at least one remote' })
export type MetadataBackupSpec = z.infer<typeof metadataBackupSpecSchema>

// ---------------------------------------------------------------------------
// Mirror backup jobs (replicate one remote's backups to others)
// ---------------------------------------------------------------------------

export const mirrorScheduleSpecSchema = z
  .object({
    name: z.string().min(1),
    cron: z.string().min(1),
    enabled: z.boolean().default(true),
    timezone: z.string().optional(),
    retention: z.number().int().min(0).optional(),
    settings: z.record(z.unknown()).default({}),
  })
  .strict()
export type MirrorScheduleSpec = z.infer<typeof mirrorScheduleSpecSchema>

export const mirrorBackupSpecSchema = z
  .object({
    name: z.string().min(1),
    mode: z.enum(['full', 'delta']),
    // remote name whose backups are mirrored
    sourceRemote: z.string().min(1),
    // destination remote names
    remotes: z.array(z.string()).nonempty(),
    settings: z.record(z.unknown()).default({}),
    schedules: z.array(mirrorScheduleSpecSchema).default([]),
  })
  .strict()
export type MirrorBackupSpec = z.infer<typeof mirrorBackupSpecSchema>

// ---------------------------------------------------------------------------
// Sequences (run backup schedules one after another)
// ---------------------------------------------------------------------------

// A sequence step references a schedule by the job it belongs to and that
// schedule's name. Jobs and schedules are matched by name at apply time.
export const sequenceStepSchema = z
  .object({
    // name of a backupJob / metadataBackup / mirrorBackup defined here or in XO
    job: z.string().min(1),
    // that job's schedule name to run for this step
    schedule: z.string().min(1),
  })
  .strict()
export type SequenceStep = z.infer<typeof sequenceStepSchema>

export const sequenceSpecSchema = z
  .object({
    name: z.string().min(1),
    // ordered list of schedules to run
    steps: z.array(sequenceStepSchema).nonempty(),
    // when the sequence itself runs
    cron: z.string().min(1),
    enabled: z.boolean().default(true),
    timezone: z.string().optional(),
  })
  .strict()
export type SequenceSpec = z.infer<typeof sequenceSpecSchema>

// ---------------------------------------------------------------------------
// Users & groups (local auth provider only)
// ---------------------------------------------------------------------------

// XO's global role. 'none' means the user has no permissions beyond what ACLs
// grant; 'admin' is a full administrator.
export const userPermissionSchema = z.enum(['none', 'read', 'write', 'admin'])
export type UserPermission = z.infer<typeof userPermissionSchema>

export const userSpecSchema = z
  .object({
    // the login / identity of the user (XO calls this "email")
    email: z.string().min(1),
    // local-auth password. Use a ${env:...} reference — it is resolved before
    // validation (see config/load.ts). XO never returns passwords, so this is
    // only ever written, never compared. Omit to leave an existing password
    // untouched on update (a new user then has no usable password).
    password: z.string().min(1).optional(),
    permission: userPermissionSchema.optional(),
  })
  .strict()
export type UserSpec = z.infer<typeof userSpecSchema>

export const groupSpecSchema = z
  .object({
    name: z.string().min(1),
    // member users, referenced by email; resolved to ids at apply time
    users: z.array(z.string().min(1)).default([]),
  })
  .strict()
export type GroupSpec = z.infer<typeof groupSpecSchema>

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
    metadataBackups: z.array(metadataBackupSpecSchema).optional(),
    mirrorBackups: z.array(mirrorBackupSpecSchema).optional(),
    sequences: z.array(sequenceSpecSchema).optional(),
    users: z.array(userSpecSchema).optional(),
    groups: z.array(groupSpecSchema).optional(),
  })
  .strict()
export type Spec = z.infer<typeof specSchema>

export function validateSpec(data: unknown): Spec {
  const spec = specSchema.parse(data)

  const dupes = (names: string[]) => names.filter((n, i) => names.indexOf(n) !== i)
  const remoteDupes = dupes((spec.remotes ?? []).map(r => r.name))
  if (remoteDupes.length > 0) {
    throw new Error(`duplicate remote name(s): ${[...new Set(remoteDupes)].join(', ')}`)
  }
  // Job names must be unique across ALL job kinds — sequences reference jobs by
  // name, and XO stores them in overlapping namespaces, so a name collision is
  // ambiguous.
  const allJobs: Array<{ kind: string; name: string; schedules: { name: string }[] }> = [
    ...(spec.backupJobs ?? []).map(j => ({ kind: 'backup job', name: j.name, schedules: j.schedules })),
    ...(spec.metadataBackups ?? []).map(j => ({ kind: 'metadata backup', name: j.name, schedules: j.schedules })),
    ...(spec.mirrorBackups ?? []).map(j => ({ kind: 'mirror backup', name: j.name, schedules: j.schedules })),
  ]
  const jobDupes = dupes(allJobs.map(j => j.name))
  if (jobDupes.length > 0) {
    throw new Error(`duplicate job name(s) across backup/metadata/mirror jobs: ${[...new Set(jobDupes)].join(', ')}`)
  }
  for (const job of allJobs) {
    const schedDupes = dupes(job.schedules.map(s => s.name))
    if (schedDupes.length > 0) {
      throw new Error(`${job.kind} "${job.name}": duplicate schedule name(s): ${[...new Set(schedDupes)].join(', ')}`)
    }
  }
  const seqDupes = dupes((spec.sequences ?? []).map(s => s.name))
  if (seqDupes.length > 0) {
    throw new Error(`duplicate sequence name(s): ${[...new Set(seqDupes)].join(', ')}`)
  }

  const userDupes = dupes((spec.users ?? []).map(u => u.email))
  if (userDupes.length > 0) {
    throw new Error(`duplicate user email(s): ${[...new Set(userDupes)].join(', ')}`)
  }
  const groupDupes = dupes((spec.groups ?? []).map(g => g.name))
  if (groupDupes.length > 0) {
    throw new Error(`duplicate group name(s): ${[...new Set(groupDupes)].join(', ')}`)
  }
  for (const group of spec.groups ?? []) {
    const memberDupes = dupes(group.users)
    if (memberDupes.length > 0) {
      throw new Error(`group "${group.name}": duplicate member(s): ${[...new Set(memberDupes)].join(', ')}`)
    }
  }
  return spec
}
