import { describe, expect, it } from 'vitest'
import { validateSpec } from '../src/config/schema.js'
import { buildPlan, planHasChanges, planHasDrift, type ActualState } from '../src/engine/plan.js'
import { idPattern, tagsPattern } from '../src/resources/patterns.js'

const emptyXo: ActualState = { remotes: [], jobs: [], schedules: [], vms: [] }

const populatedXo: ActualState = {
  remotes: [{ id: 'remote-1', name: 'nas', url: 'nfs://nas.lan:/backups', enabled: true }],
  jobs: [
    {
      id: 'job-1',
      name: 'nightly',
      type: 'backup',
      mode: 'delta',
      vms: tagsPattern(['critical']),
      remotes: idPattern(['remote-1']),
      settings: { '': {}, 'sched-1': { exportRetention: 14 } },
    },
  ],
  schedules: [{ id: 'sched-1', jobId: 'job-1', cron: '0 2 * * *', enabled: true, name: 'nightly' }],
  vms: [],
}

const fullSpec = validateSpec({
  remotes: [{ name: 'nas', type: 'nfs', host: 'nas.lan', path: '/backups' }],
  backupJobs: [
    {
      name: 'nightly',
      mode: 'delta',
      vms: { tag: 'critical' },
      remotes: ['nas'],
      schedules: [{ name: 'nightly', cron: '0 2 * * *', retention: 14 }],
    },
  ],
})

describe('buildPlan', () => {
  it('plans creation of everything on an empty XO', () => {
    const plan = buildPlan(fullSpec, emptyXo)
    expect(plan.remotes.map(r => r.kind)).toEqual(['create'])
    expect(plan.jobs.map(j => j.kind)).toEqual(['create'])
    expect(planHasChanges(plan)).toBe(true)
  })

  it('is a no-op when XO already matches', () => {
    const plan = buildPlan(fullSpec, populatedXo)
    expect(plan.remotes.map(r => r.kind)).toEqual(['noop'])
    expect(plan.jobs.map(j => j.kind)).toEqual(['noop'])
    expect(planHasChanges(plan)).toBe(false)
    expect(planHasDrift(plan)).toBe(false)
  })

  it('reports untracked resources as drift without deleting them', () => {
    const spec = validateSpec({ remotes: [], backupJobs: [] })
    const plan = buildPlan(spec, populatedXo)
    expect(plan.untrackedRemotes.map(r => r.name)).toEqual(['nas'])
    expect(plan.untrackedJobs.map(j => j.name)).toEqual(['nightly'])
    expect(planHasChanges(plan)).toBe(false)
    expect(planHasDrift(plan)).toBe(true)
  })

  it('ignores resource types whose section is absent from the file', () => {
    const spec = validateSpec({
      backupJobs: [
        {
          name: 'nightly',
          mode: 'delta',
          vms: { tag: 'critical' },
          remotes: ['nas'],
          schedules: [{ name: 'nightly', cron: '0 2 * * *', retention: 14 }],
        },
      ],
    })
    const plan = buildPlan(spec, populatedXo)
    expect(plan.remotesManaged).toBe(false)
    expect(plan.untrackedRemotes).toEqual([])
    expect(planHasDrift(plan)).toBe(false)
  })

  it('allows jobs to reference remotes that already exist in XO', () => {
    const spec = validateSpec({
      backupJobs: [
        {
          name: 'new-job',
          mode: 'full',
          vms: { tag: 'prod' },
          remotes: ['nas'],
          schedules: [],
        },
      ],
    })
    const plan = buildPlan(spec, populatedXo)
    expect(plan.jobs[0].kind).toBe('create')
  })

  it('rejects jobs referencing unknown remotes', () => {
    const spec = validateSpec({
      backupJobs: [{ name: 'j', mode: 'full', vms: { tag: 'x' }, remotes: ['ghost'], schedules: [] }],
    })
    expect(() => buildPlan(spec, emptyXo)).toThrow(/references remote "ghost"/)
  })

  it('detects an update to an existing remote', () => {
    const spec = validateSpec({
      remotes: [{ name: 'nas', type: 'nfs', host: 'nas.lan', path: '/new-path' }],
    })
    const plan = buildPlan(spec, populatedXo)
    expect(plan.remotes[0].kind).toBe('update')
    expect(plan.remotes[0].changes[0].field).toBe('url')
  })
})
