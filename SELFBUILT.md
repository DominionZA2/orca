# Self-built Orca (notification-title fix)

*Set up 2026-09-01 by Claude (claude-fable-5) with Michael. This file lives on the
`selfbuilt` branch and travels with it through updates.*

## Why this exists

Orca's OS notifications for **folder workspaces** (the Jira ticket workspaces,
e.g. API-792) showed the raw workspace key instead of the workspace name:

> `folder:d2990635-8134-4308-850a-155594ec5456 - Claude finished`

Cause: `dispatchTerminalNotification` in
`src/renderer/src/components/terminal-pane/use-notification-dispatch.ts` resolved
labels only through the git-worktree map; `folder:<id>` keys always missed it and
fell back to the raw id. Git worktrees (e.g. `cloud_backend / API-771 : …`) were
never affected. No upstream issue existed when checked (2026-09-01).

Fixed by resolving `folder:` keys via `parseWorkspaceKey` + `state.folderWorkspaces`
+ the existing `folderWorkspaceToWorktree` adapter. Verified live on API-792.

## What runs on this machine

- **Daily driver**: `dist/linux-unpacked/orca-ide` built from the `selfbuilt`
  branch. Launch via the **"Orca"** shortcut — pinnable to the dock. The entry file is
  `~/.local/share/applications/orca.desktop`: it MUST keep that exact name.
  Orca's windows carry the Wayland app-id `orca`, and GNOME matches app-id to
  desktop-file basename — any other name and the running windows get filed
  under GNOME's screen reader (also `orca`), producing a phantom third dock
  icon while clicks on the real pin appear dead. The user-level file shadows
  the screen reader's menu entry (the screen reader itself is unaffected).
- **Fallback**: the packaged deb (`orca-ide` package) is still installed at
  `/opt/Orca`, launchable as **"Orca (packaged)"**. Deliberately kept. Run only
  one at a time (they share config; a single-instance lock guards mistakes).
- **Config** is shared and lives in `~/.config/orca` and `~/.orca` — independent
  of which build runs. Nothing was migrated; nothing to lose on switch.

## Branch model

- `selfbuilt` = newest Orca **release tag** + 2 local commits:
  1. the notification fix,
  2. `ORCA_SKIP_GLIBC_FLOOR` escape hatch for the release-portability gate
     (local builds only run on this machine, so the Ubuntu 20.04 glibc floor
     doesn't apply).
- Releases are cut from release branches — **tags, not `main`, match shipped
  versions**. Updates rebase `selfbuilt` onto the newest non-rc `v*` tag.
- `fix/folder-workspace-notification-title` (off `main`) holds the PR-ready
  version of the fix. **No PR raised — Michael's explicit decision to defer.**
- Commits here need `--no-verify` (husky isn't on PATH outside pnpm scripts).

## Update machinery

Fully automatic since 2026-09-02: launching Orca from the dock **and** an hourly
timer both run the updater; when a new release tag exists it rebuilds itself in
the background and raises a persistent notification with a **Restart Orca now**
button. Restarting is deliberately the only manual step — an auto-restart would
kill live agent sessions.

| Piece | Where | Role |
|---|---|---|
| `orca-selfbuilt-launch` | `~/.local/bin` | Desktop entry's Exec: starts the app instantly, then runs the updater in the background |
| `orca-selfbuilt-update` | `~/.local/bin` | The one updater: fetch → rebase local commits onto newest tag → `pnpm install` → build → **Restart Orca now** notification. flock-guarded; add `--force` to rebuild the current tag |
| `orca-selfbuilt-restart` | `~/.local/bin` | Graceful stop + relaunch of the self-built app |
| `orca-selfbuilt-update-check.timer` | `~/.config/systemd/user` | Hourly trigger (`systemctl --user list-timers` to inspect) |
| State + logs | `~/.local/state/orca-selfbuilt/` | `built-tag` = currently built release; `update.log`, `switchover.log` |

Two hard-won rules baked into the updater:
- `git fetch --tags --force` — upstream re-points release tags occasionally
  (v1.4.195 was); without `--force` the fetch exits non-zero on the moved tag
  and everything downstream dies silently.
- Rebase is `git rebase --onto <new-tag> $(git describe --tags --abbrev=0 selfbuilt) selfbuilt`
  — release tags don't share linear history, so a plain `git rebase <new-tag>`
  replays the old release branch's own commits and conflicts everywhere; and
  the base comes from `git describe`, not the state file, so a hand-resolved
  conflict can't confuse the next run.

The build step is `pnpm run build:desktop` +
`ORCA_SKIP_GLIBC_FLOOR=1 pnpm exec electron-builder --config config/electron-builder.config.cjs --dir`.
After every build, `resources/app-update.yml` is deleted from the output so the
self-built app can never auto-update itself over the fix — updates only come
from this machinery. `pnpm` is the corepack shim at `~/.local/bin/pnpm`.

## System pieces you'd otherwise forget

- **AppArmor**: `/etc/apparmor.d/orca-ide-selfbuilt` grants user namespaces to
  the self-built binary path (this kernel restricts unprivileged userns; the deb
  instead ships a root-SUID `chrome-sandbox`, which a local build doesn't have).
  Survives rebuilds because it's keyed to the stable output path.
- **Icons**: copied to `~/.local/share/icons/hicolor/*/apps/orca-ide.png` so
  they survive if the deb is ever removed.
- **The Orca daemon** (`orca-ide … daemon-entry.js`) outlives the app and holds
  live terminal sessions. Anything that kills/waits on Orca must match the main
  UI process only — full-commandline match `^<binary-path>$` — never a prefix
  match on the binary (that bug stalled the original switchover and would have
  killed sessions on restart).

## If something breaks

- Update failed? Read `~/.local/state/orca-selfbuilt/update.log`; a rebase
  conflict means resolving it in this repo on `selfbuilt`, then rerunning
  `orca-selfbuilt-update --force`.
- Self-built won't start? Launch **"Orca (packaged)"** — untouched fallback —
  and check the AppArmor profile is still loaded (`sudo apparmor_parser -r /etc/apparmor.d/orca-ide-selfbuilt`).
- Claude context: the paired memory file is
  `~/.claude/projects/-home-msmit-Source-cloud-backend/memory/orca-notification-fix-local-build.md` —
  any Claude session picks this story up from there; pointing it at this file
  gives the full picture.
