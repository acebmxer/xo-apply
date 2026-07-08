import { describe, expect, it } from 'vitest'
import { serverSpecSchema, validateSpec } from '../src/config/schema.js'
import {
  diffServer,
  envVarNameForServer,
  serverSpecToDesired,
  serverToSpec,
} from '../src/resources/servers.js'
import { buildPlan, planHasChanges, planUntrackedCount, type ActualState } from '../src/engine/plan.js'
import type { XoServer } from '../src/client/index.js'

const emptyXo: ActualState = {
  remotes: [],
  jobs: [],
  metadataJobs: [],
  mirrorJobs: [],
  callJobs: [],
  schedules: [],
  vms: [],
  users: [],
  groups: [],
  servers: [],
}

describe('server schema', () => {
  it('parses a valid server and defaults allowUnauthorized/enabled', () => {
    const s = serverSpecSchema.parse({ host: 'pool.lan', username: 'root', password: 'secret' })
    expect(s.host).toBe('pool.lan')
    expect(s.allowUnauthorized).toBe(false)
    expect(s.enabled).toBe(true)
  })

  it('rejects unknown keys', () => {
    expect(() => serverSpecSchema.parse({ host: 'p', username: 'root', bogus: 1 })).toThrow()
  })

  it('requires host and username', () => {
    expect(() => serverSpecSchema.parse({ username: 'root' })).toThrow()
    expect(() => serverSpecSchema.parse({ host: 'p' })).toThrow()
  })

  it('detects duplicate server hosts', () => {
    expect(() =>
      validateSpec({ servers: [{ host: 'p.lan', username: 'root' }, { host: 'p.lan', username: 'admin' }] })
    ).toThrow(/duplicate server host/)
  })
})

describe('serverSpecToDesired', () => {
  it('carries fields through with defaults applied', () => {
    const d = serverSpecToDesired(serverSpecSchema.parse({ host: 'p.lan', username: 'root', password: 'p' }))
    expect(d).toEqual({
      host: 'p.lan',
      username: 'root',
      label: undefined,
      allowUnauthorized: false,
      enabled: true,
      password: 'p',
    })
  })
})

describe('diffServer', () => {
  const desired = serverSpecToDesired(
    serverSpecSchema.parse({ host: 'p.lan', username: 'root', password: 'p', label: 'Prod', allowUnauthorized: true })
  )

  it('reports label / username / allowUnauthorized / enabled changes', () => {
    const actual: XoServer = { id: '1', host: 'p.lan', username: 'admin', label: 'Old', allowUnauthorized: false, enabled: false }
    expect(diffServer(desired, actual)).toEqual([
      { field: 'label', from: 'Old', to: 'Prod' },
      { field: 'username', from: 'admin', to: 'root' },
      { field: 'allowUnauthorized', from: false, to: true },
      { field: 'enabled', from: false, to: true },
    ])
  })

  it('never diffs the password (in sync despite a password being set)', () => {
    const actual: XoServer = { id: '1', host: 'p.lan', username: 'root', label: 'Prod', allowUnauthorized: true, enabled: true }
    expect(diffServer(desired, actual)).toEqual([])
  })

  it('treats a missing actual enabled/allowUnauthorized as false', () => {
    const d = serverSpecToDesired(serverSpecSchema.parse({ host: 'p.lan', username: 'root', enabled: false }))
    expect(diffServer(d, { id: '1', host: 'p.lan', username: 'root' })).toEqual([])
  })

  it('treats empty-string and undefined labels as equal', () => {
    const d = serverSpecToDesired(serverSpecSchema.parse({ host: 'p.lan', username: 'root' }))
    expect(diffServer(d, { id: '1', host: 'p.lan', username: 'root', label: '', enabled: true })).toEqual([])
  })
})

describe('serverToSpec', () => {
  it('exports host/username with a ${env:...} password placeholder, omitting defaults', () => {
    const { spec, secretEnvVar } = serverToSpec({ id: '1', host: 'pool-a.lan', username: 'root', enabled: true })
    expect(spec).toEqual({ host: 'pool-a.lan', username: 'root', password: '${env:XO_SERVER_POOL_A_LAN_PASSWORD}' })
    expect(secretEnvVar).toBe('XO_SERVER_POOL_A_LAN_PASSWORD')
  })

  it('includes label / allowUnauthorized / disabled when non-default', () => {
    const { spec } = serverToSpec({
      id: '1',
      host: 'p.lan',
      username: 'root',
      label: 'Prod',
      allowUnauthorized: true,
      enabled: false,
    })
    expect(spec).toMatchObject({ label: 'Prod', allowUnauthorized: true, enabled: false })
  })

  it('derives a clean env var name from an IP host', () => {
    expect(envVarNameForServer('192.168.1.10')).toBe('XO_SERVER_192_168_1_10_PASSWORD')
  })
})

describe('buildPlan: servers', () => {
  it('plans create for a new server', () => {
    const spec = validateSpec({ servers: [{ host: 'p.lan', username: 'root', password: 'p' }] })
    const plan = buildPlan(spec, emptyXo)
    expect(plan.servers.map(s => s.kind)).toEqual(['create'])
    expect(planHasChanges(plan)).toBe(true)
  })

  it('plans noop when the server matches (password ignored)', () => {
    const actual: ActualState = {
      ...emptyXo,
      servers: [{ id: '1', host: 'p.lan', username: 'root', enabled: true, allowUnauthorized: false }],
    }
    const plan = buildPlan(validateSpec({ servers: [{ host: 'p.lan', username: 'root', password: 'p' }] }), actual)
    expect(plan.servers.map(s => s.kind)).toEqual(['noop'])
    expect(planHasChanges(plan)).toBe(false)
  })

  it('surfaces an untracked server only when servers are managed', () => {
    const actual: ActualState = { ...emptyXo, servers: [{ id: '1', host: 'p.lan', username: 'root', enabled: true }] }
    // managed, file lists none
    const managed = buildPlan(validateSpec({ servers: [] }), actual)
    expect(managed.serversManaged).toBe(true)
    expect(managed.untrackedServers.map(s => s.host)).toEqual(['p.lan'])
    expect(planUntrackedCount(managed)).toBe(1)
    // section absent → unmanaged, no drift
    const unmanaged = buildPlan(validateSpec({}), actual)
    expect(unmanaged.serversManaged).toBe(false)
    expect(unmanaged.untrackedServers).toEqual([])
  })
})
