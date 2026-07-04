import { describe, expect, it } from 'vitest'
import { backupJobSpecSchema } from '../src/config/schema.js'
import {
  buildVmIndex,
  diffJob,
  jobSpecToDesired,
  matchSchedules,
  type RemoteMapping,
} from '../src/resources/backup-jobs.js'
import { idPattern, tagsPattern } from '../src/resources/patterns.js'
import type { XoBackupJob, XoSchedule, XoVm } from '../src/client/index.js'

const vms: XoVm[] = [
  { id: 'uuid-web', name_label: 'web-01' },
  { id: 'uuid-db', name_label: 'db-01' },
  { id: 'uuid-dup-a', name_label: 'clone' },
  { id: 'uuid-dup-b', name_label: 'clone' },
]
const vmIndex = buildVmIndex(vms)
const parseJob = (raw: unknown) => backupJobSpecSchema.parse(raw)

const mapping: RemoteMapping = {
  remoteNameById: new Map([['remote-1', 'nas']]),
  pendingRemoteNames: new Set(),
}

describe('jobSpecToDesired', () => {
  it('builds a tag smart-mode pattern (tags wrapped in arrays)', () => {
    const desired = jobSpecToDesired(
      parseJob({ name: 'j', mode: 'delta', vms: { tag: 'critical' }, remotes: ['nas'], schedules: [] }),
      vmIndex
    )
    expect(desired.vms).toEqual({ type: 'VM', tags: { __or: [['critical']] } })
  })

  it('resolves VM names to uuids', () => {
    const desired = jobSpecToDesired(
      parseJob({ name: 'j', mode: 'full', vms: { names: ['web-01', 'db-01'] }, schedules: [] }),
      vmIndex
    )
    expect(desired.vms).toEqual({ id: { __or: ['uuid-db', 'uuid-web'] } })
  })

  it('uses the single-id shape for one VM', () => {
    const desired = jobSpecToDesired(
      parseJob({ name: 'j', mode: 'full', vms: { names: ['web-01'] }, schedules: [] }),
      vmIndex
    )
    expect(desired.vms).toEqual({ id: 'uuid-web' })
  })

  it('rejects unknown VM names', () => {
    expect(() =>
      jobSpecToDesired(parseJob({ name: 'j', mode: 'full', vms: { names: ['nope'] }, schedules: [] }), vmIndex)
    ).toThrow(/no VM found/)
  })

  it('rejects ambiguous VM names', () => {
    expect(() =>
      jobSpecToDesired(parseJob({ name: 'j', mode: 'full', vms: { names: ['clone'] }, schedules: [] }), vmIndex)
    ).toThrow(/ambiguous/)
  })
})

function actualJobFixture(): { job: XoBackupJob; schedules: XoSchedule[] } {
  return {
    job: {
      id: 'job-1',
      name: 'nightly',
      type: 'backup',
      mode: 'delta',
      vms: tagsPattern(['critical']),
      remotes: idPattern(['remote-1']),
      settings: {
        '': { concurrency: 2, reportWhen: 'failure' },
        'sched-1': { exportRetention: 14 },
      },
    },
    schedules: [{ id: 'sched-1', jobId: 'job-1', cron: '0 2 * * *', enabled: true, name: 'nightly' }],
  }
}

const nightlySpec = {
  name: 'nightly',
  mode: 'delta',
  vms: { tag: 'critical' },
  remotes: ['nas'],
  settings: { concurrency: 2 },
  schedules: [{ name: 'nightly', cron: '0 2 * * *', retention: 14 }],
}

describe('diffJob', () => {
  it('reports in-sync for a matching job (ignoring unmanaged settings)', () => {
    const desired = jobSpecToDesired(parseJob(nightlySpec), vmIndex)
    const diff = diffJob(desired, actualJobFixture(), mapping)
    expect(diff.changes).toEqual([])
    expect(diff.scheduleChanges).toEqual([])
  })

  it('detects a retention change', () => {
    const desired = jobSpecToDesired(
      parseJob({ ...nightlySpec, schedules: [{ name: 'nightly', cron: '0 2 * * *', retention: 30 }] }),
      vmIndex
    )
    const diff = diffJob(desired, actualJobFixture(), mapping)
    expect(diff.changes).toEqual([])
    expect(diff.scheduleChanges).toHaveLength(1)
    const change = diff.scheduleChanges[0]
    expect(change.kind).toBe('update')
    expect(change.kind === 'update' && change.changes).toEqual([{ field: 'retention', from: 14, to: 30 }])
  })

  it('detects mode and remote changes', () => {
    const desired = jobSpecToDesired(parseJob({ ...nightlySpec, mode: 'full', remotes: ['other'] }), vmIndex)
    const diff = diffJob(desired, actualJobFixture(), mapping)
    const fields = diff.changes.map(c => c.field)
    expect(fields).toContain('mode')
    expect(fields).toContain('remotes')
  })

  it('plans schedule creation and deletion', () => {
    const desired = jobSpecToDesired(
      parseJob({ ...nightlySpec, schedules: [{ name: 'weekly', cron: '0 3 * * 0', retention: 8 }] }),
      vmIndex
    )
    const diff = diffJob(desired, actualJobFixture(), mapping)
    const kinds = diff.scheduleChanges.map(c => c.kind).sort()
    expect(kinds).toEqual(['create', 'delete'])
  })

  it('treats pattern order as irrelevant', () => {
    const desired = jobSpecToDesired(
      parseJob({ ...nightlySpec, vms: { tags: ['b', 'a'] }, schedules: [] }),
      vmIndex
    )
    const actual = actualJobFixture()
    actual.job.vms = { type: 'VM', tags: { __or: [['a'], ['b']] } }
    actual.schedules = []
    actual.job.settings = { '': { concurrency: 2 } }
    const diff = diffJob(desired, actual, mapping)
    expect(diff.changes).toEqual([])
  })
})

describe('matchSchedules', () => {
  it('falls back to cron matching for unnamed schedules', () => {
    const { pairs, unmatchedDesired, unmatchedActual } = matchSchedules(
      [{ name: 'nightly', cron: '0 2 * * *', enabled: true }],
      [{ id: 's1', jobId: 'j', cron: '0 2 * * *' }]
    )
    expect(pairs).toHaveLength(1)
    expect(unmatchedDesired).toEqual([])
    expect(unmatchedActual).toEqual([])
  })
})
