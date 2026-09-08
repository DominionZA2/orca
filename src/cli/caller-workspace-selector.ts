import { resolve as resolvePath } from 'node:path'
import type { RuntimeWorktreeListResult, RuntimeWorktreeRecord } from '../shared/runtime-types'
import { isPathInsideOrEqual } from '../shared/cross-platform-path'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'

export function assertLocalCwdWorktreeSelector(selector: string, client: RuntimeClient): void {
  if (!client.isRemote) {
    return
  }
  // Why: a paired CLI's cwd belongs to the client machine, not the runtime
  // server, so cwd-derived worktree selectors are only valid locally.
  throw new RuntimeClientError(
    'invalid_argument',
    `${selector} is a local cwd shortcut and cannot be resolved against a remote runtime. Pass an explicit server-side worktree selector such as identity:<identity>, id:<repo-id>::<path>, name:<displayName>, branch:<branch>, issue:<number>, or path:<absolute-server-path>.`
  )
}

export async function resolveCurrentWorktreeSelector(
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  assertLocalCwdWorktreeSelector('current', client)

  const currentPath = resolvePath(cwd)
  const worktrees = await client.call<RuntimeWorktreeListResult>('worktree.list', {
    limit: 10_000
  })
  let enclosingWorktree: RuntimeWorktreeRecord | undefined
  let enclosingPathLength = -1
  for (const worktree of worktrees.result.worktrees) {
    const worktreePath = resolvePath(worktree.path)
    if (
      !isPathInsideOrEqual(worktreePath, currentPath) ||
      worktreePath.length <= enclosingPathLength
    ) {
      continue
    }
    enclosingWorktree = worktree
    enclosingPathLength = worktreePath.length
  }

  if (!enclosingWorktree) {
    throw new RuntimeClientError(
      'selector_not_found',
      `No Orca-managed worktree contains the current directory: ${currentPath}`
    )
  }

  // Why: users expect "active/current" to mean the enclosing managed worktree
  // even from nested subdirectories. Resolve to the concrete runtime id here:
  // duplicate repo registrations can expose the same Git worktree path, and a
  // path selector would throw selector_ambiguous after losing the repo id.
  return `id:${enclosingWorktree.id}`
}

/**
 * The workspace Orca stamped into the terminal this CLI was invoked from, or undefined outside one.
 *
 * Why `id:` for a git worktree: a bare worktree id is also matched against paths and branches, so
 * only the explicit form narrows to the repo that owns it. A folder workspace key is already
 * unambiguous and is the form the runtime's folder resolvers accept.
 */
export function getOrcaTerminalWorkspaceSelector(): string | undefined {
  const worktreeId = process.env.ORCA_WORKTREE_ID?.trim()
  if (worktreeId) {
    return worktreeId.startsWith('folder:') ? worktreeId : `id:${worktreeId}`
  }
  const workspaceId = process.env.ORCA_WORKSPACE_ID?.trim()
  return workspaceId?.startsWith('folder:') ? workspaceId : undefined
}

/**
 * The workspace a command targets when the caller named none.
 *
 * Why the terminal environment outranks cwd: Orca stamps every terminal it spawns with the
 * workspace that owns it, and that is the workspace the caller means — a Folder Workspace root
 * matches no git worktree at all, and an agent that has cd'd into a child repo still speaks for
 * the workspace its terminal belongs to.
 */
export async function resolveCallerWorkspaceSelector(
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  assertLocalCwdWorktreeSelector('current', client)
  return getOrcaTerminalWorkspaceSelector() ?? (await resolveCurrentWorktreeSelector(cwd, client))
}

/** The same default, for commands that may run unscoped rather than fail. */
export async function resolveOptionalCallerWorkspaceSelector(
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  if (client.isRemote) {
    return undefined
  }
  try {
    return await resolveCallerWorkspaceSelector(cwd, client)
  } catch {
    // Not inside a managed workspace — no filter
    return undefined
  }
}
