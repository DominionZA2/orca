import {
  isWorktreeCreatePreparation,
  parseWorktreePreparationOwnerPid,
  parseWorktreePreparationPathOwnerPid
} from '../shared/worktree/create-preparation'
import type { AddWorktreeOptions } from './git/worktree'
import { listWorktreeGraph } from './git/worktree'
import { discardPreparedWorktree, unlockPreparedWorktree } from './git/worktree-create-preparation'
import { retryPendingPreparationDiscards } from './worktree-preparation-discard-retry'

const STALE_PREPARATION_CLEANUP_CONCURRENCY = 4

const reclaimInFlight = new Map<string, Promise<void>>()

/** One repo on one Git host: the scope a stranded discard is retried under. */
export function preparationHostKey(repoPathKey: string, wslDistro: string): string {
  return `${repoPathKey}\0${wslDistro}`
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Discards prepared checkouts left behind by an Orca process that is gone.
 *
 * `repoPathKey` is the caller's already-normalized path key; the reclaim is single-flighted per
 * repo and Git host so a burst of warm-ups does not rescan the worktree graph once each.
 */
export async function reclaimStaleWorktreePreparations(
  repoPathKey: string,
  repoPath: string,
  options: AddWorktreeOptions
): Promise<void> {
  const reclaimKey = preparationHostKey(repoPathKey, options.wslDistro ?? '')
  const existing = reclaimInFlight.get(reclaimKey)
  if (existing) {
    await existing.catch(() => {})
    return
  }
  const reclaim = (async () => {
    // Not awaited: the create path awaits this reclaim, and one stranded discard costs an unlock plus
    // a `worktree remove --force` bounded at 30s each. Reclaiming leaked scratch must not delay create.
    void retryPendingPreparationDiscards(reclaimKey)
    const worktrees = await listWorktreeGraph(repoPath, {
      ...options,
      includeCreatePreparations: true
    })
    const staleWorktrees = worktrees.filter(isWorktreeCreatePreparation)
    let nextIndex = 0
    async function discardNextStalePreparation(): Promise<void> {
      while (nextIndex < staleWorktrees.length) {
        const worktree = staleWorktrees[nextIndex]
        nextIndex += 1
        const lockOwnerPid = parseWorktreePreparationOwnerPid(worktree.lockReason)
        const pathOwnerPid = parseWorktreePreparationPathOwnerPid(worktree.path)
        if (!lockOwnerPid || isProcessAlive(lockOwnerPid)) {
          continue
        }
        // Preserve a branch-attached final path after a crash; only detached or
        // still-hidden preparations are safe to discard automatically.
        if (worktree.branch && pathOwnerPid === null) {
          await unlockPreparedWorktree(repoPath, worktree.path, options).catch(() => {})
        } else if (pathOwnerPid === lockOwnerPid) {
          await discardPreparedWorktree(repoPath, worktree.path, options).catch(() => {})
        }
      }
    }
    const workerCount = Math.min(STALE_PREPARATION_CLEANUP_CONCURRENCY, staleWorktrees.length)
    await Promise.all(Array.from({ length: workerCount }, () => discardNextStalePreparation()))
  })()
  reclaimInFlight.set(reclaimKey, reclaim)
  try {
    await reclaim.catch(() => {})
  } finally {
    if (reclaimInFlight.get(reclaimKey) === reclaim) {
      reclaimInFlight.delete(reclaimKey)
    }
  }
}

export function _resetStalePreparationReclaimForTests(): void {
  reclaimInFlight.clear()
}
