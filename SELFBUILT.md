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
  branch. Launch via the **"Orca"** shortcut (`~/.local/share/applications/orca-selfbuilt.desktop`) — pinnable to the dock.
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

| Piece | Where | Role |
|---|---|---|
| `orca-selfbuilt-check-updates` | `~/.local/bin` | Hourly check; on a new release tag raises a **persistent** notification with an **Update now** button |
| `orca-selfbuilt-update` | `~/.local/bin` | Fetch → rebase `selfbuilt` onto newest tag → `pnpm install` → build → notify with **Restart Orca now** button. Manual: `orca-selfbuilt-update` (add `--force` to rebuild the current tag) |
| `orca-selfbuilt-restart` | `~/.local/bin` | Graceful stop + relaunch of the self-built app |
| `orca-selfbuilt-update-check.timer` | `~/.config/systemd/user` | Hourly trigger (`systemctl --user list-timers` to inspect) |
| State + logs | `~/.local/state/orca-selfbuilt/` | `built-tag` = currently built release; `update.log`, `switchover.log` |

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
