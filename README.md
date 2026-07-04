# xo-apply

**Configuration-as-code for [Xen Orchestra](https://xen-orchestra.com/).**
Declare your backup remotes, backup jobs and schedules in a YAML file, keep it
in git, and reconcile any XO instance to match it — the same model Terraform
uses for cloud accounts.

```console
$ xo-apply diff config.yaml
Remotes:
  + create  nas-backups  (nfs://192.168.1.50:/export/xo-backups)
Backup jobs:
  + create  nightly-critical  (delta, 1 schedule)
  ~ update  weekly-full
      ~ schedule weekly
          retention: 4 → 8

Plan: 2 to create, 1 to update, 0 untracked
```

## Why

XO stores backup jobs, schedules and remotes only in its own database. There is
no way to write them down in a reviewable file — rebuilding an XO means
re-creating every backup job by hand in the UI. With xo-apply:

- **Rebuild in seconds**: reinstall XO (e.g. with
  [install_xen_orchestra](https://github.com/...)), then `xo-apply apply config.yaml`.
- **Review changes in git**: every config change is a commit with an author and a diff.
- **Detect drift**: `xo-apply diff` tells you when someone changed a job in the
  UI and it no longer matches the file.
- **Clone configs**: apply one file to several XO instances.

## Install

```bash
npm install -g xo-apply     # or: npx xo-apply ...
```

Requires Node.js ≥ 20 and a Xen Orchestra recent enough to expose the REST API
(`/rest/v0` — any current XO from sources or XOA).

## Connect to your XO

xo-apply needs your XO URL and an authentication token:

```bash
export XO_URL=https://xo.example.lan
export XO_TOKEN=...
```

(or pass `--url` / `--token`; add `--insecure` for self-signed certificates).

Create a token either with `xo-cli create-token xo.example.lan admin@example.com`
or directly through the REST API:

```bash
curl -X POST -u 'admin@example.com:password' \
  https://xo.example.lan/rest/v0/users/me/authentication_tokens
```

The token must belong to an **admin** user (backup management requires it).

## Commands

| Command | What it does |
|---|---|
| `xo-apply export [-o file]` | Read the connected XO and write its configuration as editable YAML. Secrets are replaced by `${env:...}` placeholders. |
| `xo-apply diff config.yaml` | Compare file vs. XO. Changes nothing. Exit code: `0` in sync, `2` drift, `1` error. |
| `xo-apply apply config.yaml` | Show the plan, confirm, then create/update resources to match the file. `--yes` skips confirmation, `--dry-run` only shows the plan. |
| `xo-apply apply config.yaml --prune` | Additionally **delete** resources that exist in XO but not in the file. |

Typical first run against an existing XO:

```bash
xo-apply export -o config.yaml   # write down what you have
git init && git add config.yaml  # keep it in your own PRIVATE repo
xo-apply diff config.yaml        # → "In sync"
```

## The config file

See [example-config.yaml](example-config.yaml) for a fully commented example.

```yaml
remotes:
  - name: nas-backups
    type: nfs                 # nfs | smb | s3 | local
    host: 192.168.1.50
    path: /export/xo-backups

backupJobs:
  - name: nightly-critical
    mode: delta               # delta (incremental) | full
    vms:
      tag: critical           # every VM tagged "critical" (smart mode)
    remotes: [nas-backups]
    schedules:
      - name: nightly
        cron: "0 2 * * *"
        retention: 14
```

### Semantics

- Resources are **matched by `name`** — rename a job in the file and xo-apply
  will plan a delete (with `--prune`) + create, not a rename.
- A **section that is absent** from the file (`remotes:` or `backupJobs:`) is
  unmanaged: xo-apply neither reports nor deletes that resource type. An
  empty section (`backupJobs: []`) claims ownership: everything of that type is
  reported as untracked and deleted with `--prune`.
- A job's **schedules are fully owned by the job entry**: removing a schedule
  from the file deletes it on apply (no `--prune` needed).
- Job `settings` are applied on top of XO's: keys you don't list are left
  alone, so XO-side defaults never show up as drift.
- VM selection: `tag`/`tags` (smart mode — VMs added later with the tag are
  picked up automatically), `names` or `uuids` (explicit list), or `raw`
  (a verbatim XO smart-mode pattern for anything more complex).

### Secrets

Never put credentials in the file. Use `${env:VAR_NAME}` and provide the value
as an environment variable at run time:

```yaml
password: ${env:SMB_BACKUP_PASSWORD}
```

`xo-apply export` writes placeholders automatically and warns you which
variables you need to set. Keep real values in your shell, a `.env` you don't
commit, or your CI's secret store.

## How it talks to XO

XO's REST API (`/rest/v0`) is used wherever it supports writes (remotes, VM
lookups). Backup jobs and schedules are read/written through XO's JSON-RPC
websocket API via [`xo-lib`](https://www.npmjs.com/package/xo-lib) — the same
client `xo-cli` uses — because the REST API doesn't expose those writes yet.
As the REST API reaches feature parity this will migrate transparently.

No state file is kept: the running XO is always the source of "actual" state.

## Roadmap

- [ ] Users & groups
- [ ] Servers (pool connections)
- [ ] ACLs / RBAC (ACL v2 REST endpoints)
- [ ] Metadata & mirror backup jobs
- [ ] Backup job health checks / sequences

## Development

```bash
npm install
npm test          # unit tests (vitest)
npm run build     # tsc → dist/
npm run dev -- diff config.yaml
```

## License

Copyright © 2026 acebmxer.

xo-apply is licensed under the
[GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later).

This license is required — and fitting: xo-apply links two AGPL-licensed
libraries published by [Vates SAS](https://vates.tech/), the makers of Xen
Orchestra, so the combined work must be AGPL as well. It is the same license
Xen Orchestra itself uses.

## Credits

This tool stands on work by **Vates SAS** and the Xen Orchestra project
(<https://github.com/vatesfr/xen-orchestra>):

- [`xo-lib`](https://www.npmjs.com/package/xo-lib) (AGPL-3.0-or-later, © Vates SAS) —
  the JSON-RPC websocket client used to talk to `xo-server`, the same one
  `xo-cli` uses.
- [`xo-remote-parser`](https://www.npmjs.com/package/xo-remote-parser)
  (AGPL-3.0-or-later, © Vates SAS) — builds and parses XO's backup remote URLs,
  guaranteeing byte-for-byte compatibility with XO.
- The wire formats this tool produces (backup job smart-mode patterns,
  `backupNg` payload shapes, schedule settings) were derived by studying the
  `xen-orchestra` source code (AGPL-3.0) and its
  [REST API documentation](https://docs.xen-orchestra.com/restapi).

xo-apply is an independent community project and is not affiliated with or
endorsed by Vates.
