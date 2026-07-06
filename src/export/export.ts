import { stringify } from 'yaml'
import type { ActualState } from '../engine/plan.js'
import { extractIds, extractTags } from '../resources/patterns.js'
import { remoteToSpec } from '../resources/remotes.js'
import { extractSequenceScheduleIds, SEQUENCE_METHOD } from '../resources/sequences.js'
import { EXPORT_PASSWORD_PLACEHOLDER, isLocalUser, userToSpec } from '../resources/users.js'
import { groupToSpec, isLocalGroup } from '../resources/groups.js'

export interface ExportResult {
  yaml: string
  warnings: string[]
}

/** Convert live XO state into a v1 spec document. */
export function exportSpec(actual: ActualState): ExportResult {
  const warnings: string[] = []

  const remotes: Record<string, unknown>[] = []
  for (const remote of actual.remotes) {
    try {
      const { spec, secretEnvVar } = remoteToSpec(remote)
      remotes.push(spec)
      if (secretEnvVar !== undefined) {
        warnings.push(
          `remote "${remote.name}": secret replaced by \${env:${secretEnvVar}} — set that environment variable before running apply`
        )
      }
    } catch (error) {
      warnings.push(`skipped remote "${remote.name}": ${(error as Error).message}`)
    }
  }

  const remoteNameById = new Map(actual.remotes.map(r => [r.id, r.name]))
  const vmNameById = new Map(actual.vms.map(vm => [vm.id, vm.name_label]))
  const vmIdsByName = new Map<string, number>()
  for (const vm of actual.vms) {
    vmIdsByName.set(vm.name_label, (vmIdsByName.get(vm.name_label) ?? 0) + 1)
  }

  const schedulesByJob = new Map<string, typeof actual.schedules>()
  for (const schedule of actual.schedules) {
    const list = schedulesByJob.get(schedule.jobId) ?? []
    list.push(schedule)
    schedulesByJob.set(schedule.jobId, list)
  }

  const backupJobs: Record<string, unknown>[] = []
  for (const job of actual.jobs) {
    const spec: Record<string, unknown> = {
      name: job.name,
      mode: job.mode,
    }
    if (job.compression !== undefined && job.compression !== '') {
      spec.compression = job.compression
    }

    // vms selector
    const tags = extractTags(job.vms)
    const ids = tags === undefined ? extractIds(job.vms) : undefined
    if (tags !== undefined) {
      spec.vms = tags.length === 1 ? { tag: tags[0] } : { tags }
    } else if (ids !== undefined) {
      const names: string[] = []
      let useNames = true
      for (const id of ids) {
        const name = vmNameById.get(id)
        if (name === undefined || (vmIdsByName.get(name) ?? 0) > 1) {
          useNames = false
          break
        }
        names.push(name)
      }
      if (useNames) {
        spec.vms = { names }
      } else {
        spec.vms = { uuids: ids }
        warnings.push(
          `backup job "${job.name}": exported VM selection as uuids (some VMs are missing or have ambiguous names)`
        )
      }
    } else {
      spec.vms = { raw: job.vms }
      warnings.push(`backup job "${job.name}": complex smart-mode pattern exported as vms.raw`)
    }

    // remotes
    const remoteIds = extractIds(job.remotes) ?? []
    const remoteNames: string[] = []
    for (const id of remoteIds) {
      const name = remoteNameById.get(id)
      if (name === undefined) {
        warnings.push(`backup job "${job.name}": references unknown remote id ${id}; exported as-is`)
        remoteNames.push(id)
      } else {
        remoteNames.push(name)
      }
    }
    if (remoteNames.length > 0) {
      spec.remotes = remoteNames
    }

    // target SRs (DR / Continuous Replication)
    const srIds = extractIds(job.srs) ?? []
    if (srIds.length > 0) {
      spec.srs = srIds
    }

    // global settings
    const globalSettings = { ...(job.settings[''] ?? {}) }
    if (Object.keys(globalSettings).length > 0) {
      spec.settings = globalSettings
    }

    // schedules
    const schedules = schedulesByJob.get(job.id) ?? []
    spec.schedules = schedules.map((schedule, i) => {
      const schedSpec: Record<string, unknown> = {
        name: schedule.name && schedule.name !== '' ? schedule.name : `schedule-${i + 1}`,
        cron: schedule.cron,
      }
      if (schedule.enabled === false) {
        schedSpec.enabled = false
      }
      if (schedule.timezone !== undefined) {
        schedSpec.timezone = schedule.timezone
      }
      const schedSettings = job.settings[schedule.id] ?? {}
      if (typeof schedSettings.exportRetention === 'number' && schedSettings.exportRetention > 0) {
        schedSpec.retention = schedSettings.exportRetention
      }
      if (typeof schedSettings.snapshotRetention === 'number' && schedSettings.snapshotRetention > 0) {
        schedSpec.snapshotRetention = schedSettings.snapshotRetention
      }
      // preserve any other per-schedule settings (fullInterval, health checks…)
      const extra = Object.fromEntries(
        Object.entries(schedSettings).filter(([key]) => key !== 'exportRetention' && key !== 'snapshotRetention')
      )
      if (Object.keys(extra).length > 0) {
        schedSpec.settings = extra
      }
      return schedSpec
    })

    backupJobs.push(spec)
  }

  // -- metadata backups -----------------------------------------------------

  const metadataBackups: Record<string, unknown>[] = []
  for (const job of actual.metadataJobs) {
    const spec: Record<string, unknown> = { name: job.name }
    if (job.xoMetadata) spec.xoMetadata = true
    const poolIds = extractIds(job.pools) ?? []
    if (poolIds.length > 0) spec.pools = poolIds
    const remoteIds = extractIds(job.remotes) ?? []
    const remoteNames = remoteIds.map(id => remoteNameById.get(id) ?? id)
    if (remoteNames.length > 0) spec.remotes = remoteNames
    const globalSettings = { ...(job.settings[''] ?? {}) }
    if (Object.keys(globalSettings).length > 0) spec.settings = globalSettings
    const scheds = schedulesByJob.get(job.id) ?? []
    spec.schedules = scheds.map((s, i) => {
      const out: Record<string, unknown> = {
        name: s.name && s.name !== '' ? s.name : `schedule-${i + 1}`,
        cron: s.cron,
      }
      if (s.enabled === false) out.enabled = false
      if (s.timezone !== undefined) out.timezone = s.timezone
      const set = job.settings[s.id] ?? {}
      if (typeof set.retentionPoolMetadata === 'number') out.poolRetention = set.retentionPoolMetadata
      if (typeof set.retentionXoMetadata === 'number') out.xoRetention = set.retentionXoMetadata
      const extra = Object.fromEntries(
        Object.entries(set).filter(([k]) => k !== 'retentionPoolMetadata' && k !== 'retentionXoMetadata')
      )
      if (Object.keys(extra).length > 0) out.settings = extra
      return out
    })
    metadataBackups.push(spec)
  }

  // -- mirror backups -------------------------------------------------------

  const mirrorBackups: Record<string, unknown>[] = []
  for (const job of actual.mirrorJobs) {
    const spec: Record<string, unknown> = { name: job.name, mode: job.mode }
    if (job.sourceRemote !== undefined) {
      spec.sourceRemote = remoteNameById.get(job.sourceRemote) ?? job.sourceRemote
    }
    const remoteIds = extractIds(job.remotes) ?? []
    const remoteNames = remoteIds.map(id => remoteNameById.get(id) ?? id)
    if (remoteNames.length > 0) spec.remotes = remoteNames
    const globalSettings = { ...(job.settings[''] ?? {}) }
    if (Object.keys(globalSettings).length > 0) spec.settings = globalSettings
    const scheds = schedulesByJob.get(job.id) ?? []
    spec.schedules = scheds.map((s, i) => {
      const out: Record<string, unknown> = {
        name: s.name && s.name !== '' ? s.name : `schedule-${i + 1}`,
        cron: s.cron,
      }
      if (s.enabled === false) out.enabled = false
      if (s.timezone !== undefined) out.timezone = s.timezone
      const set = job.settings[s.id] ?? {}
      if (typeof set.exportRetention === 'number' && set.exportRetention > 0) out.retention = set.exportRetention
      const extra = Object.fromEntries(Object.entries(set).filter(([k]) => k !== 'exportRetention'))
      if (Object.keys(extra).length > 0) out.settings = extra
      return out
    })
    mirrorBackups.push(spec)
  }

  // -- sequences ------------------------------------------------------------

  // schedule id → (jobName, scheduleName) across every job kind, so we can map
  // a sequence's ordered schedule-id list back to readable step references.
  const jobNameById = new Map<string, string>()
  for (const j of actual.jobs) jobNameById.set(j.id, j.name)
  for (const j of actual.metadataJobs) jobNameById.set(j.id, j.name)
  for (const j of actual.mirrorJobs) jobNameById.set(j.id, j.name)
  const stepByScheduleId = new Map<string, { job: string; schedule: string }>()
  for (const s of actual.schedules) {
    const jobName = jobNameById.get(s.jobId)
    if (jobName !== undefined && s.name) {
      stepByScheduleId.set(s.id, { job: jobName, schedule: s.name })
    }
  }
  const triggerByJobId = new Map<string, typeof actual.schedules[number]>()
  for (const s of actual.schedules) triggerByJobId.set(s.jobId, s)

  const sequences: Record<string, unknown>[] = []
  for (const job of actual.callJobs) {
    if (job.type !== 'call' || job.method !== SEQUENCE_METHOD) continue
    const scheduleIds = extractSequenceScheduleIds(job)
    const steps = scheduleIds.map(id => {
      const step = stepByScheduleId.get(id)
      if (step === undefined) {
        warnings.push(`sequence "${job.name}": step references schedule id ${id} whose job/schedule name is unknown; exported as raw id`)
        return { job: id, schedule: '?' }
      }
      return step
    })
    const trigger = triggerByJobId.get(job.id)
    const spec: Record<string, unknown> = { name: job.name, steps }
    if (trigger !== undefined) {
      spec.cron = trigger.cron
      if (trigger.enabled === false) spec.enabled = false
      if (trigger.timezone !== undefined) spec.timezone = trigger.timezone
    } else {
      warnings.push(`sequence "${job.name}": has no trigger schedule; cron omitted (set one before apply)`)
    }
    sequences.push(spec)
  }

  // -- users & groups (local only) ------------------------------------------

  const users: Record<string, unknown>[] = []
  let skippedExternalUsers = 0
  for (const user of actual.users) {
    if (!isLocalUser(user)) {
      skippedExternalUsers++
      continue
    }
    const { spec } = userToSpec(user)
    users.push(spec)
  }
  if (users.length > 0) {
    warnings.push(
      `${users.length} local user(s) exported with the placeholder password "${EXPORT_PASSWORD_PLACEHOLDER}" ` +
        `(XO does not return real passwords) — change these in the file before importing into a real XO`
    )
  }
  if (skippedExternalUsers > 0) {
    warnings.push(`skipped ${skippedExternalUsers} externally-provisioned user(s) (managed by their auth plugin)`)
  }

  const userEmailById = new Map(actual.users.map(u => [u.id, u.email]))
  const groups: Record<string, unknown>[] = []
  let skippedExternalGroups = 0
  for (const group of actual.groups) {
    if (!isLocalGroup(group)) {
      skippedExternalGroups++
      continue
    }
    groups.push(groupToSpec(group, userEmailById))
  }
  if (skippedExternalGroups > 0) {
    warnings.push(`skipped ${skippedExternalGroups} externally-synchronized group(s) (managed by their auth plugin)`)
  }

  const doc: Record<string, unknown> = {}
  doc.remotes = remotes
  doc.backupJobs = backupJobs
  if (metadataBackups.length > 0) doc.metadataBackups = metadataBackups
  if (mirrorBackups.length > 0) doc.mirrorBackups = mirrorBackups
  if (sequences.length > 0) doc.sequences = sequences
  if (users.length > 0) doc.users = users
  if (groups.length > 0) doc.groups = groups

  const header =
    `# Xen Orchestra configuration exported by xo-apply on ${new Date().toISOString()}\n` +
    `# Secrets are NOT exported: \${env:...} placeholders must be provided as environment variables.\n`
  return { yaml: header + stringify(doc), warnings }
}
