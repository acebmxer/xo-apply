import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSpec, resolveEnvRefs } from '../src/config/load.js'

const writeTmp = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'xo-apply-test-'))
  const file = join(dir, 'config.yaml')
  writeFileSync(file, content)
  return file
}

describe('resolveEnvRefs', () => {
  it('substitutes env vars in nested structures', () => {
    const missing = new Set<string>()
    const result = resolveEnvRefs({ a: [{ b: 'x-${env:FOO}-y' }] }, missing, { FOO: 'bar' })
    expect(result).toEqual({ a: [{ b: 'x-bar-y' }] })
    expect(missing.size).toBe(0)
  })

  it('collects missing variables', () => {
    const missing = new Set<string>()
    resolveEnvRefs({ a: '${env:NOPE}', b: '${env:ALSO_NOPE}' }, missing, {})
    expect([...missing].sort()).toEqual(['ALSO_NOPE', 'NOPE'])
  })
})

describe('loadSpec', () => {
  it('loads and validates a valid file', () => {
    const file = writeTmp(
      [
        'remotes:',
        '  - name: nas',
        '    type: nfs',
        '    host: nas.lan',
        '    path: /backups',
        'backupJobs:',
        '  - name: nightly',
        '    mode: delta',
        '    vms:',
        '      tag: critical',
        '    remotes: [nas]',
        '    schedules:',
        '      - name: nightly',
        '        cron: "0 2 * * *"',
        '        retention: 14',
      ].join('\n')
    )
    const spec = loadSpec(file)
    expect(spec.remotes).toHaveLength(1)
    expect(spec.backupJobs?.[0].schedules[0].enabled).toBe(true)
  })

  it('fails on missing env vars with a clear message', () => {
    const file = writeTmp(
      [
        'remotes:',
        '  - name: win',
        '    type: smb',
        '    host: h\\share',
        '    domain: D',
        '    username: u',
        '    password: ${env:XO_APPLY_TEST_SURELY_UNSET}',
      ].join('\n')
    )
    expect(() => loadSpec(file)).toThrow(/XO_APPLY_TEST_SURELY_UNSET/)
  })

  it('fails on unknown fields', () => {
    const file = writeTmp(['remotes:', '  - name: nas', '    type: nfs', '    host: h', '    path: /p', '    bogus: 1'].join('\n'))
    expect(() => loadSpec(file)).toThrow(/bogus|unrecognized/i)
  })

  it('fails on duplicate names', () => {
    const file = writeTmp(
      [
        'remotes:',
        '  - {name: nas, type: nfs, host: h, path: /p}',
        '  - {name: nas, type: nfs, host: h2, path: /p2}',
      ].join('\n')
    )
    expect(() => loadSpec(file)).toThrow(/duplicate remote/)
  })
})
