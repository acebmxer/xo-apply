import { describe, expect, it } from 'vitest'
import { remoteSpecSchema } from '../src/config/schema.js'
import { diffRemote, envVarNameForRemote, maskUrl, remoteSpecToDesired, remoteToSpec } from '../src/resources/remotes.js'
import type { XoRemote } from '../src/client/index.js'

const parseSpec = (raw: unknown) => remoteSpecSchema.parse(raw)

describe('remoteSpecToDesired', () => {
  it('builds an NFS url', () => {
    const desired = remoteSpecToDesired(
      parseSpec({ name: 'nas', type: 'nfs', host: '192.168.1.50', path: '/export/xo-backups', mountOptions: 'vers=4' })
    )
    expect(desired.url).toBe('nfs://192.168.1.50:/export/xo-backups')
    expect(desired.options).toBe('vers=4')
  })

  it('builds an NFS url with port', () => {
    const desired = remoteSpecToDesired(
      parseSpec({ name: 'nas', type: 'nfs', host: 'nas.lan', port: 2049, path: '/backups' })
    )
    expect(desired.url).toBe('nfs://nas.lan:2049:/backups')
  })

  it('builds an SMB url', () => {
    const desired = remoteSpecToDesired(
      parseSpec({
        name: 'winshare',
        type: 'smb',
        host: '192.168.1.60\\backups',
        domain: 'WORKGROUP',
        username: 'backup',
        password: 'hunter2',
      })
    )
    expect(desired.url).toBe('smb://backup:hunter2@WORKGROUP\\\\192.168.1.60\\backups\0')
  })

  it('builds an S3 url with region', () => {
    const desired = remoteSpecToDesired(
      parseSpec({
        name: 's3',
        type: 's3',
        host: 's3.us-east-1.amazonaws.com',
        path: 'my-bucket/xo',
        accessKey: 'AKIA123',
        secretKey: 'secret/with+chars',
        region: 'us-east-1',
      })
    )
    expect(desired.url).toBe('s3://AKIA123:secret%2Fwith%2Bchars@s3.us-east-1.amazonaws.com/my-bucket/xo#us-east-1')
  })

  it('builds a local url', () => {
    const desired = remoteSpecToDesired(parseSpec({ name: 'usb', type: 'local', path: '/mnt/usb' }))
    expect(desired.url).toBe('file:///mnt/usb')
  })
})

describe('remoteToSpec (export round-trip)', () => {
  it('round-trips an NFS remote', () => {
    const remote: XoRemote = {
      id: 'r1',
      name: 'nas',
      url: 'nfs://192.168.1.50:/export/xo-backups',
      options: 'vers=4',
    }
    const { spec, secretEnvVar } = remoteToSpec(remote)
    expect(secretEnvVar).toBeUndefined()
    expect(spec).toMatchObject({ name: 'nas', type: 'nfs', host: '192.168.1.50', path: '/export/xo-backups' })
    // re-applying the exported spec must produce the same url
    const desired = remoteSpecToDesired(parseSpec(spec))
    expect(desired.url).toBe(remote.url)
    expect(desired.options).toBe('vers=4')
  })

  it('replaces SMB password with an env placeholder', () => {
    const remote: XoRemote = {
      id: 'r2',
      name: 'win share',
      url: 'smb://backup:hunter2@WORKGROUP\\\\192.168.1.60\\backups\0',
    }
    const { spec, secretEnvVar } = remoteToSpec(remote)
    expect(secretEnvVar).toBe('XO_REMOTE_WIN_SHARE_SECRET')
    expect(spec.password).toBe('${env:XO_REMOTE_WIN_SHARE_SECRET}')
    expect(spec.username).toBe('backup')
  })

  it('round-trips an S3 remote when the secret is provided', () => {
    const remote: XoRemote = {
      id: 'r3',
      name: 'offsite',
      url: 's3://AKIA123:topsecret@s3.example.com/bucket/dir#eu-west-1',
    }
    const { spec, secretEnvVar } = remoteToSpec(remote)
    expect(secretEnvVar).toBe('XO_REMOTE_OFFSITE_SECRET')
    const withSecret = { ...spec, secretKey: 'topsecret' }
    const desired = remoteSpecToDesired(parseSpec(withSecret))
    expect(desired.url).toBe(remote.url)
  })
})

describe('diffRemote', () => {
  it('reports no change for an identical remote', () => {
    const spec = parseSpec({ name: 'nas', type: 'nfs', host: 'nas.lan', path: '/backups' })
    const desired = remoteSpecToDesired(spec)
    const actual: XoRemote = { id: 'r1', name: 'nas', url: 'nfs://nas.lan:/backups' }
    expect(diffRemote(desired, actual)).toEqual([])
  })

  it('detects a changed path with masked urls', () => {
    const spec = parseSpec({
      name: 'win',
      type: 'smb',
      host: 'h\\share',
      domain: 'D',
      username: 'u',
      password: 'pw',
    })
    const desired = remoteSpecToDesired(spec)
    const actual: XoRemote = { id: 'r1', name: 'win', url: 'smb://u:otherpw@D\\\\h\\share\0' }
    const changes = diffRemote(desired, actual)
    expect(changes).toHaveLength(1)
    expect(changes[0].field).toBe('url')
    expect(String(changes[0].from)).not.toContain('otherpw')
    expect(String(changes[0].to)).not.toContain('pw@')
  })
})

describe('maskUrl', () => {
  it('masks smb passwords', () => {
    expect(maskUrl('smb://u:secret@D\\\\host\\share\0')).not.toContain('secret')
  })
  it('leaves nfs urls untouched', () => {
    expect(maskUrl('nfs://host:/path')).toBe('nfs://host:/path')
  })
})

describe('envVarNameForRemote', () => {
  it('sanitizes names', () => {
    expect(envVarNameForRemote('my nas (main)')).toBe('XO_REMOTE_MY_NAS_MAIN_SECRET')
  })
})
