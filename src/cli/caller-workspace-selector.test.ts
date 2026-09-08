/**
 * The CLI runs inside terminals Orca spawned, and Orca stamps each of those with the workspace
 * that owns it. Only the emulator commands used to read that stamp, so a browser or terminal
 * command issued from a Folder Workspace fell through to whichever workspace the UI had focused.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from './runtime-client'
import { useOrcaTerminalWorkspaceEnvironment } from './index-test-harness'
import {
  getBrowserWorktreeSelector,
  getEmulatorWorktreeSelector,
  resolveCallerWorkspaceSelector,
  resolveCurrentWorktreeSelector
} from './selectors'

const FOLDER_KEY = 'folder:52d2e7a3-c08f-4d0e-9771-f7581df19b6c'
const WORKTREE_ID = 'repo::/tmp/repo/feature'

function makeClient(
  worktreePaths: readonly string[] = [],
  isRemote = false,
  folderWorkspaces: readonly { id: string; folderPath: string }[] = []
) {
  const call = vi.fn(async (method: string) => {
    if (method === 'folderWorkspace.list') {
      return { result: { folderWorkspaces } }
    }
    if (method !== 'worktree.list') {
      throw new Error(`unexpected method ${method}`)
    }
    const worktrees = worktreePaths.map((path) => ({ id: `repo::${path}`, path }))
    return { result: { worktrees, totalCount: worktrees.length, truncated: false } }
  })
  return { client: { isRemote, call } as unknown as RuntimeClient, call }
}

function flags(entries: Record<string, string | boolean> = {}): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

describe('the workspace an unscoped CLI command targets', () => {
  useOrcaTerminalWorkspaceEnvironment()

  it('names the git worktree the calling terminal belongs to', async () => {
    process.env.ORCA_WORKTREE_ID = WORKTREE_ID
    const { client, call } = makeClient()

    await expect(getBrowserWorktreeSelector(flags(), '/elsewhere', client)).resolves.toBe(
      `id:${WORKTREE_ID}`
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('names the folder workspace the calling terminal belongs to', async () => {
    process.env.ORCA_WORKTREE_ID = FOLDER_KEY
    process.env.ORCA_WORKSPACE_ID = FOLDER_KEY
    const { client } = makeClient()

    await expect(getBrowserWorktreeSelector(flags(), '/elsewhere', client)).resolves.toBe(
      FOLDER_KEY
    )
  })

  it('falls back to the folder workspace id when only the workspace stamp survives', async () => {
    process.env.ORCA_WORKSPACE_ID = FOLDER_KEY
    const { client } = makeClient()

    await expect(getBrowserWorktreeSelector(flags(), '/elsewhere', client)).resolves.toBe(
      FOLDER_KEY
    )
  })

  it('prefers the worktree stamp over a stale parent workspace stamp', async () => {
    process.env.ORCA_WORKSPACE_ID = 'folder:stale-parent'
    process.env.ORCA_WORKTREE_ID = WORKTREE_ID
    const { client } = makeClient()

    await expect(getBrowserWorktreeSelector(flags(), '/elsewhere', client)).resolves.toBe(
      `id:${WORKTREE_ID}`
    )
  })

  it('ignores a workspace stamp that names no folder workspace', async () => {
    process.env.ORCA_WORKSPACE_ID = 'worktree:repo::/tmp/repo/feature'
    const { client, call } = makeClient(['/tmp/repo/feature'])

    await expect(
      getBrowserWorktreeSelector(flags(), '/tmp/repo/feature/src', client)
    ).resolves.toBe(`id:${WORKTREE_ID}`)
    expect(call).toHaveBeenCalledWith('worktree.list', { limit: 10_000 })
  })

  it('lets an explicit selector outrank the terminal it was typed in', async () => {
    process.env.ORCA_WORKTREE_ID = FOLDER_KEY
    const { client } = makeClient()

    await expect(
      getBrowserWorktreeSelector(flags({ worktree: 'identity:other' }), '/elsewhere', client)
    ).resolves.toBe('identity:other')
  })

  it('keeps `--worktree all` unscoped inside an Orca terminal', async () => {
    process.env.ORCA_WORKTREE_ID = FOLDER_KEY
    const { client } = makeClient()

    await expect(
      getBrowserWorktreeSelector(flags({ worktree: 'all' }), '/elsewhere', client)
    ).resolves.toBeUndefined()
  })

  it('keeps `--worktree current` meaning the current directory', async () => {
    // Why: `current` is the caller asking about cwd explicitly, so the terminal stamp must not win.
    process.env.ORCA_WORKTREE_ID = FOLDER_KEY
    const { client } = makeClient(['/tmp/repo/feature'])

    await expect(
      getBrowserWorktreeSelector(flags({ worktree: 'current' }), '/tmp/repo/feature/src', client)
    ).resolves.toBe(`id:${WORKTREE_ID}`)
  })

  it('resolves from the current directory outside an Orca terminal', async () => {
    const { client } = makeClient(['/tmp/repo/feature'])

    await expect(
      getBrowserWorktreeSelector(flags(), '/tmp/repo/feature/src', client)
    ).resolves.toBe(`id:${WORKTREE_ID}`)
  })

  it('stays unscoped for a directory no workspace claims', async () => {
    const { client } = makeClient(['/tmp/repo/feature'])

    await expect(
      getBrowserWorktreeSelector(flags(), '/tmp/unmanaged', client)
    ).resolves.toBeUndefined()
  })

  it('leaves a remote client on server-side focus', async () => {
    process.env.ORCA_WORKTREE_ID = WORKTREE_ID
    const { client, call } = makeClient([], true)

    await expect(
      getBrowserWorktreeSelector(flags(), '/tmp/repo/feature', client)
    ).resolves.toBeUndefined()
    await expect(
      getEmulatorWorktreeSelector(flags(), '/tmp/repo/feature', client)
    ).resolves.toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a remote `worktree current` rather than reading the client environment', async () => {
    process.env.ORCA_WORKTREE_ID = WORKTREE_ID
    const { client } = makeClient([], true)

    await expect(resolveCallerWorkspaceSelector('/tmp/repo/feature', client)).rejects.toMatchObject(
      { code: 'invalid_argument' }
    )
  })

  it('gives emulator commands the same terminal workspace', async () => {
    process.env.ORCA_WORKTREE_ID = FOLDER_KEY
    const { client } = makeClient()

    await expect(getEmulatorWorktreeSelector(flags(), '/elsewhere', client)).resolves.toBe(
      FOLDER_KEY
    )
  })
})

describe('resolving the current directory against every managed workspace', () => {
  useOrcaTerminalWorkspaceEnvironment()

  const TICKET_FOLDER = [{ id: 'folder-1', folderPath: '/tmp/tickets/API-783' }]

  it('resolves a Folder Workspace root that matches no git worktree', async () => {
    const { client, call } = makeClient([], false, TICKET_FOLDER)

    await expect(resolveCurrentWorktreeSelector('/tmp/tickets/API-783', client)).resolves.toBe(
      'folder:folder-1'
    )
    expect(call).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(call).toHaveBeenNthCalledWith(2, 'folderWorkspace.list')
  })

  it('resolves a subdirectory of a Folder Workspace to that folder', async () => {
    const { client } = makeClient([], false, TICKET_FOLDER)

    await expect(
      resolveCurrentWorktreeSelector('/tmp/tickets/API-783/notes', client)
    ).resolves.toBe('folder:folder-1')
  })

  it('prefers a git worktree nested inside the ticket folder', async () => {
    const { client, call } = makeClient(['/tmp/tickets/API-783/pos_frontend'], false, TICKET_FOLDER)

    await expect(
      resolveCurrentWorktreeSelector('/tmp/tickets/API-783/pos_frontend/src', client)
    ).resolves.toBe('id:repo::/tmp/tickets/API-783/pos_frontend')
    // Why: the worktree already answers the question, so the folder catalog is never read.
    expect(call).toHaveBeenCalledOnce()
  })

  it('refuses a directory no managed workspace contains', async () => {
    const { client } = makeClient(['/tmp/repo/feature'], false, TICKET_FOLDER)

    await expect(resolveCurrentWorktreeSelector('/tmp/elsewhere', client)).rejects.toMatchObject({
      code: 'selector_not_found'
    })
  })
})
