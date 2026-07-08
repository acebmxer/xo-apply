import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDotenv, parseDotenv } from '../src/config/dotenv.js'

describe('parseDotenv', () => {
  it('parses plain, exported, quoted and commented lines', () => {
    const raw = [
      '# a comment',
      '',
      'PLAIN=value',
      'export EXPORTED=exp',
      'DQUOTED="with spaces"',
      "SQUOTED='single'",
      'INLINE=val # trailing comment',
      'HASH_IN_QUOTES="a#b"',
      'EMPTY=',
      'bad line without eq',
      '1INVALID=nope',
    ].join('\n')
    expect(parseDotenv(raw)).toEqual([
      { key: 'PLAIN', value: 'value' },
      { key: 'EXPORTED', value: 'exp' },
      { key: 'DQUOTED', value: 'with spaces' },
      { key: 'SQUOTED', value: 'single' },
      { key: 'INLINE', value: 'val' },
      { key: 'HASH_IN_QUOTES', value: 'a#b' },
      { key: 'EMPTY', value: '' },
    ])
  })
})

describe('loadDotenv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xo-apply-dotenv-'))
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns [] and does nothing when the file is missing', () => {
    expect(loadDotenv(join(dir, 'does-not-exist'), {})).toEqual([])
  })

  it('fills only keys not already set — a real env var wins', () => {
    const path = join(dir, '.env')
    writeFileSync(path, 'FOO=from-file\nBAR=from-file\n')
    const env: NodeJS.ProcessEnv = { FOO: 'from-shell' }
    const applied = loadDotenv(path, env)
    expect(env.FOO).toBe('from-shell') // shell wins
    expect(env.BAR).toBe('from-file') // gap filled
    expect(applied).toEqual(['BAR'])
  })
})
