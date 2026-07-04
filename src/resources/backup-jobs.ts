import type { BackupJobSpec, ScheduleSpec } from '../config/schema.js'
import type { XoBackupJob, XoSchedule, XoVm } from '../client/index.js'
import { deepEqual, extractIds, idPattern, patternsEqual, tagsPattern } from './patterns.js'
import type { FieldChange } from './remotes.js'

export interface DesiredSchedule {
  name: string
  cron: string
  enabled: boolean
  timezone?: string
  retention?: number
  snapshotRetention?: number
  /** extra per-schedule XO settings, passed through verbatim */
  settings: Record<string, unknown>
}

export interface DesiredJob {
  name: string
  mode: 'full' | 'delta'
  compression?: 'native' | 'zstd'
  vms: Record<string, unknown>
  remoteNames: string[]
  settings: Record<string, unknown>
  schedules: DesiredSchedule[]
}

export interface VmResolutionContext {
  /** name_label → ids (several when the label is ambiguous) */
  vmIdsByName: Map<string, string[]>
}

export function buildVmIndex(vms: XoVm[]): VmResolutionContext {
  const vmIdsByName = new Map<string, string[]>()
  for (const vm of vms) {
    const ids = vmIdsByName.get(vm.name_label) ?? []
    ids.push(vm.id)
    vmIdsByName.set(vm.name_label, ids)
  }
  return { vmIdsByName }
}

export function jobSpecToDesired(spec: BackupJobSpec, ctx: VmResolutionContext): DesiredJob {
  let vms: Record<string, unknown>
  const selector = spec.vms
  if (selector.raw !== undefined) {
    vms = selector.raw
  } else if (selector.uuids !== undefined) {
    vms = idPattern(selector.uuids)
  } else if (selector.names !== undefined) {
    const ids: string[] = []
    for (const name of selector.names) {
      const found = ctx.vmIdsByName.get(name)
      if (found === undefined) {
        throw new Error(`backup job "${spec.name}": no VM found with name "${name}"`)
      }
      if (found.length > 1) {
        throw new Error(
          `backup job "${spec.name}": VM name "${name}" is ambiguous (${found.length} VMs); use vms.uuids instead`
        )
      }
      ids.push(found[0])
    }
    vms = idPattern(ids)
  } else {
    const tags = selector.tags ?? [selector.tag as string]
    vms = tagsPattern(tags)
  }

  return {
    name: spec.name,
    mode: spec.mode,
    compression: spec.compression,
    vms,
    remoteNames: spec.remotes,
    settings: spec.settings,
    schedules: spec.schedules.map(scheduleSpecToDesired),
  }
}

function scheduleSpecToDesired(spec: ScheduleSpec): DesiredSchedule {
  return {
    name: spec.name,
    cron: spec.cron,
    enabled: spec.enabled,
    timezone: spec.timezone,
    retention: spec.retention,
    snapshotRetention: spec.snapshotRetention,
    settings: spec.settings,
  }
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export interface ActualJob {
  job: XoBackupJob
  schedules: XoSchedule[]
}

export type ScheduleChange =
  | { kind: 'create'; desired: DesiredSchedule }
  | { kind: 'update'; desired: DesiredSchedule; actual: XoSchedule; changes: FieldChange[] }
  | { kind: 'delete'; actual: XoSchedule }

export interface JobDiff {
  changes: FieldChange[]
  scheduleChanges: ScheduleChange[]
}

export interface RemoteMapping {
  remoteNameById: Map<string, string>
  /** names of remotes that will be created by this same apply run */
  pendingRemoteNames: Set<string>
}

/** Actual remote ids → names for comparison; unknown ids stay as ids. */
function actualRemoteNames(job: XoBackupJob, mapping: RemoteMapping): string[] {
  const ids = extractIds(job.remotes) ?? []
  return ids.map(id => mapping.remoteNameById.get(id) ?? id)
}

/**
 * Match actual schedules to desired ones: by name first, then by cron for
 * schedules XO created without a name.
 */
export function matchSchedules(
  desired: DesiredSchedule[],
  actual: XoSchedule[]
): { pairs: Array<[DesiredSchedule, XoSchedule]>; unmatchedDesired: DesiredSchedule[]; unmatchedActual: XoSchedule[] } {
  const remainingActual = [...actual]
  const pairs: Array<[DesiredSchedule, XoSchedule]> = []
  const unmatchedDesired: DesiredSchedule[] = []

  for (const d of desired) {
    let index = remainingActual.findIndex(a => a.name === d.name)
    if (index === -1) {
      index = remainingActual.findIndex(a => (a.name === undefined || a.name === '') && a.cron === d.cron)
    }
    if (index === -1) {
      unmatchedDesired.push(d)
    } else {
      pairs.push([d, remainingActual[index]])
      remainingActual.splice(index, 1)
    }
  }
  return { pairs, unmatchedDesired, unmatchedActual: remainingActual }
}

export function diffJob(desired: DesiredJob, actual: ActualJob, mapping: RemoteMapping): JobDiff {
  const changes: FieldChange[] = []
  const { job } = actual

  if (desired.mode !== job.mode) {
    changes.push({ field: 'mode', from: job.mode, to: desired.mode })
  }

  const actualCompression = job.compression === '' ? undefined : job.compression
  if (desired.compression !== actualCompression) {
    changes.push({ field: 'compression', from: actualCompression, to: desired.compression })
  }

  if (!patternsEqual(desired.vms, job.vms)) {
    changes.push({ field: 'vms', from: job.vms, to: desired.vms })
  }

  const actualRemotes = actualRemoteNames(job, mapping)
  if (!deepEqual([...desired.remoteNames].sort(), [...actualRemotes].sort())) {
    changes.push({ field: 'remotes', from: actualRemotes, to: desired.remoteNames })
  }

  const actualGlobal = job.settings[''] ?? {}
  for (const [key, value] of Object.entries(desired.settings)) {
    if (!deepEqual(value, actualGlobal[key])) {
      changes.push({ field: `settings.${key}`, from: actualGlobal[key], to: value })
    }
  }

  const scheduleChanges: ScheduleChange[] = []
  const { pairs, unmatchedDesired, unmatchedActual } = matchSchedules(desired.schedules, actual.schedules)

  for (const d of unmatchedDesired) {
    scheduleChanges.push({ kind: 'create', desired: d })
  }
  for (const a of unmatchedActual) {
    scheduleChanges.push({ kind: 'delete', actual: a })
  }
  for (const [d, a] of pairs) {
    const schedChanges: FieldChange[] = []
    if (d.cron !== a.cron) {
      schedChanges.push({ field: 'cron', from: a.cron, to: d.cron })
    }
    if (d.enabled !== (a.enabled ?? false)) {
      schedChanges.push({ field: 'enabled', from: a.enabled ?? false, to: d.enabled })
    }
    if (d.timezone !== undefined && d.timezone !== a.timezone) {
      schedChanges.push({ field: 'timezone', from: a.timezone, to: d.timezone })
    }
    if ((d.name || undefined) !== (a.name || undefined)) {
      schedChanges.push({ field: 'name', from: a.name, to: d.name })
    }
    const schedSettings = job.settings[a.id] ?? {}
    if (d.retention !== undefined && !deepEqual(d.retention, schedSettings.exportRetention ?? 0)) {
      schedChanges.push({ field: 'retention', from: schedSettings.exportRetention ?? 0, to: d.retention })
    }
    if (
      d.snapshotRetention !== undefined &&
      !deepEqual(d.snapshotRetention, schedSettings.snapshotRetention ?? 0)
    ) {
      schedChanges.push({ field: 'snapshotRetention', from: schedSettings.snapshotRetention ?? 0, to: d.snapshotRetention })
    }
    for (const [key, value] of Object.entries(d.settings)) {
      if (!deepEqual(value, schedSettings[key])) {
        schedChanges.push({ field: `settings.${key}`, from: schedSettings[key], to: value })
      }
    }
    if (schedChanges.length > 0) {
      scheduleChanges.push({ kind: 'update', desired: d, actual: a, changes: schedChanges })
    }
  }

  return { changes, scheduleChanges }
}
