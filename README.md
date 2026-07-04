# xo-apply

**Migrate or rebuild [Xen Orchestra](https://xen-orchestra.com/) from code.**
Declare your XO in a YAML file, keep it in git, and stand up any instance to
match it — move to new hardware, rebuild after a loss, or keep instances
identical, without clicking through the UI.

Backups are implemented today (remotes, jobs, schedules, DR/CR, metadata,
mirror, sequences).

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

XO keeps its entire configuration locked inside its own database. There's no way
to write it down, so moving to a new XO — or rebuilding one — means re-creating
everything by hand in the UI. xo-apply makes your XO a file you own: declare it
once, and build or migrate an instance from that file. With xo-apply:

- **Rebuild in seconds**: reinstall XO (e.g. with
  [install_xen_orchestra](https://github.com/acebmxer/install_xen_orchestra)),
  then `xo-apply apply config.yaml`.
- **Review changes in git**: every config change is a commit with an author and a diff.
- **Detect drift**: `xo-apply diff` tells you when someone changed a job in the
  UI and it no longer matches the file.
- **Clone configs**: apply one file to several XO instances.

## Install

Install directly from GitHub with npm:

```bash
npm install -g https://github.com/acebmxer/xo-apply/archive/refs/heads/main.tar.gz
```

The repo ships ready to run (the compiled `dist/` is committed), so no build
tools are needed on your machine. Verify with:

```bash
xo-apply --version    # zsh users: run `rehash` first (or open a new terminal)
```

To upgrade later, re-run the same install command.

> Why the tarball URL instead of `npm install -g github:acebmxer/xo-apply`?
> Several npm versions in the wild (including current Fedora packages) have
> bugs that break **global** installs of git-based packages — they either fail
> to build them or install a symlink to a temp directory that npm deletes.
> The tarball URL avoids npm's git handling entirely and works everywhere.

> Publishing to the npm registry (`npm install -g xo-apply`) is planned; until
> then the GitHub install above is the supported method.

**On Linux/macOS, if you get `EACCES: permission denied`**: your npm global
directory is root-owned (the default on many Linux distros). Rather than using
`sudo`, point npm at a directory you own (one-time setup):

```bash
npm config set prefix ~/.npm-global
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.zshrc   # or ~/.bashrc
source ~/.zshrc
npm install -g https://github.com/acebmxer/xo-apply/archive/refs/heads/main.tar.gz
```

### Windows

xo-apply runs on Windows — it's pure Node.js and talks to XO over the network,
so nothing is platform-specific. Install [Node.js ≥ 20](https://nodejs.org/)
(the installer adds npm's global bin to your `PATH` automatically), then in
**PowerShell** run the same one-liner:

```powershell
npm install -g https://github.com/acebmxer/xo-apply/archive/refs/heads/main.tar.gz
xo-apply --version
```

You normally don't need the `npm config set prefix` / PATH steps above — those
are for Unix shells. Set connection variables with PowerShell syntax when using
env vars instead of `--url`/`--token`:

```powershell
$env:XO_URL = "https://xo.example.lan"
$env:XO_TOKEN = "..."
```

Requires Node.js ≥ 20 and a Xen Orchestra recent enough to expose the REST API
(`/rest/v0` — any current XO from sources or XOA).

## Connect to your XO

**xo-apply can run anywhere** — your workstation, a management VM, the XO host
itself. It talks to XO over the network, so one install can work against any
number of XO instances just by changing which URL/token you point it at:

```bash
export XO_URL=https://xo.example.lan
export XO_TOKEN=...
```

(or pass `--url` / `--token`; add `--insecure` for self-signed certificates).

**Each XO instance needs its own token** — tokens are per-instance, so working
with two XOs (e.g. an old and a new one) means creating a token on each.
Create one either with `xo-cli create-token xo.example.lan admin@example.com`
or directly through the REST API:

```bash
curl -X POST -u 'admin@example.com:password' \
  https://xo.example.lan/rest/v0/users/me/authentication_tokens
```

On a fresh XO installed from sources, the default login is `admin@admin.net` /
`admin` until you change it.

The token must belong to an **admin** user (backup management requires it).

## Commands

### Interactive mode (no arguments)

Run `xo-apply` with **no subcommand** to launch a guided, menu-driven UI in your
terminal — the friendliest way to get started:

```bash
xo-apply
```

It walks you through connecting (prefilled from `XO_URL`/`XO_TOKEN` or `--url`/
`--token` if set), picks a config file from the current directory, shows the
plan, and runs diff / apply / export for you. Every scriptable subcommand below
still works exactly as before, so CI and automation are unaffected. The
interactive UI needs a real terminal; in a pipe or CI job, use the subcommands.

### Scriptable subcommands

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

## Walkthrough: rebuild or migrate an XO

The main use case, step by step. You have an existing ("old") XO with backup
jobs you care about, and a freshly installed ("new") XO — e.g. a new VM built
with [install_xen_orchestra](https://github.com/acebmxer/install_xen_orchestra).

**1. Export the config from the old XO** (any machine with xo-apply installed):

```bash
# --- export from OLD XO ---
export XO_URL=https://old-xo.lan XO_TOKEN=<token-from-old-xo>
xo-apply export -o config.yaml          # add --insecure if self-signed cert
```

Review `config.yaml` in a text editor — it's meant to be read. Edit anything
you want changed on the new XO (retention, paths, jobs you no longer want).

**2. Prepare the new XO** — two things xo-apply can't do for you (yet):

- **Connect your pool(s)** in the new XO's UI (Settings → Servers). Backup
  jobs that select VMs by `names`/`uuids` need the new XO to see those VMs;
  managing pool connections from the file is on the roadmap.
- **Set any secret environment variables.** If your remotes use SMB or S3,
  the export replaced their passwords with `${env:...}` placeholders and
  printed a warning naming each variable. Set those in your shell now —
  `apply` will stop with a clear error if any are missing.

**3. Apply to the new XO** — same tool, new URL and token:

```bash
# --- apply to NEW XO ---
export XO_URL=https://new-xo.lan XO_TOKEN=<token-from-new-xo>
xo-apply diff config.yaml               # review the plan first
xo-apply apply config.yaml
```

`diff` shows exactly what will be created before you touch anything. After the
apply, run `xo-apply diff config.yaml` again — it should print **"In sync"**.
Your remotes, backup jobs and schedules are back without clicking through the
UI.

The same flow keeps two XOs identical (staging/production), and if the file
lives in git, step 1 is already done — skip straight to the new server.

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
    # srs: [<sr-uuid>]         # target SRs => DR (mode:full) / CR (mode:delta)
    schedules:
      - name: nightly
        cron: "0 2 * * *"
        retention: 14

metadataBackups:              # pool metadata + XO's own configuration
  - name: xo-config
    xoMetadata: true
    pools: [<pool-uuid>]
    remotes: [nas-backups]
    schedules:
      - { name: daily, cron: "0 21 * * *", xoRetention: 7, poolRetention: 7 }

mirrorBackups:               # copy one remote's backups onto others (e.g. S3)
  - name: offsite-mirror
    mode: full
    sourceRemote: nas-backups
    remotes: [offsite-s3]
    schedules:
      - { name: nightly, cron: "0 5 * * *", retention: 14 }

sequences:                   # run backup schedules one after another
  - name: nightly-then-metadata
    steps:
      - { job: nightly-critical, schedule: nightly }
      - { job: xo-config, schedule: daily }
    cron: "0 22 * * *"
```

### Resource types

| Section | XO feature |
|---|---|
| `remotes` | Backup repositories (NFS, SMB, S3, local) |
| `backupJobs` | VM backup jobs; add `srs:` for Disaster Recovery (`full`) / Continuous Replication (`delta`) |
| `metadataBackups` | Pool metadata and XO config backups |
| `mirrorBackups` | Mirror an existing remote's backups to other remotes |
| `sequences` | Run a list of schedules in order, on their own cron |

### Semantics

- Resources are **matched by `name`** — rename a job in the file and xo-apply
  will plan a delete (with `--prune`) + create, not a rename.
- A **section that is absent** from the file (e.g. `remotes:`, `backupJobs:`,
  `metadataBackups:`, `mirrorBackups:`, `sequences:`) is unmanaged: xo-apply
  neither reports nor deletes that resource type. An empty section
  (`backupJobs: []`) claims ownership: everything of that type is reported as
  untracked and deleted with `--prune`.
- A **sequence step** references a job by name and one of that job's named
  schedules (`{ job: ..., schedule: ... }`); the referenced job may be defined
  in the same file or already exist in XO. Order is significant.
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

- [x] Metadata & mirror backup jobs
- [x] Backup sequences
- [x] Disaster Recovery / Continuous Replication (SR targets)
- [ ] Users & groups
- [ ] Servers (pool connections)
- [ ] ACLs / RBAC (ACL v2 REST endpoints)
- [ ] Backup job health checks (partial: pass-through via schedule `settings`)

## Development

```bash
npm install
npm test          # unit tests (vitest)
npm run build     # tsc → dist/
npm run dev -- diff config.yaml
```

Note: `dist/` is committed on purpose — it's what lets users install straight
from a GitHub tarball without build tools on their machine (npm cannot
reliably build globally installed git/tarball packages). When you change
anything in `src/`, run `npm run build` and commit the updated `dist/`
together with the source change.

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
