import type { OpenFile } from '@/store/slices/editor'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'

// Why: some filesystems (Google Drive for desktop's virtual drive, other cloud/network mounts) deliver create/delete notifications but none for in-place writes, so an open tab never learns that an agent rewrote its file. Polling mtime/size of open local tabs is the backstop; a detected change is replayed through the normal fs:changed handler so reload, dirty-conflict and self-write rules stay in one place.
export const EDITOR_EXTERNAL_WATCH_POLL_INTERVAL_MS = 3_000
// Why: bounds the stat fan-out per tick when many tabs are open.
const MAX_POLLED_FILES_PER_TARGET = 64
// Why: a save stamps the path just before writeFile, so the mtime it produces can land slightly after the previous poll's snapshot.
const SELF_WRITE_SLACK_MS = 1_000
const WATCHER_EVENT_RETENTION_MS = 60_000
const MAX_WATCHER_EVENT_ENTRIES = 512

type PollSnapshot = { mtime: number; size: number; polledAt: number }

export type EditorExternalWatchPollDeps = {
  getTargets: () => readonly EditorExternalWatchTarget[]
  getOpenFiles: () => readonly OpenFile[]
  statFile: (file: OpenFile) => Promise<{ mtime: number; size: number }>
  getLastSelfWriteAt: (absolutePath: string) => number | null
  handleFsChanged: (payload: FsChangedPayload) => void
  now?: () => number
}

export type EditorExternalWatchPoller = {
  pollNow: () => Promise<void>
  /** Records paths the real watcher already reported so the poll does not replay them. */
  noteWatcherPayload: (payload: FsChangedPayload) => void
  /** Starts the interval and focus triggers; returns the teardown. */
  start: () => () => void
}

function isPollableFile(file: OpenFile): boolean {
  return (file.mode === 'edit' || file.mode === 'markdown-preview') && file.filePath.length > 0
}

export function createEditorExternalWatchPoller(
  deps: EditorExternalWatchPollDeps
): EditorExternalWatchPoller {
  const now = deps.now ?? Date.now
  const snapshots = new Map<string, PollSnapshot>()
  const watcherEventAt = new Map<string, number>()
  let polling = false

  const noteWatcherPayload = (payload: FsChangedPayload): void => {
    const at = now()
    for (const event of payload.events) {
      if (event.kind !== 'overflow') {
        watcherEventAt.set(normalizeRuntimePathForComparison(event.absolutePath), at)
      }
    }
    if (watcherEventAt.size > MAX_WATCHER_EVENT_ENTRIES) {
      for (const [path, eventAt] of watcherEventAt) {
        if (at - eventAt > WATCHER_EVENT_RETENTION_MS) {
          watcherEventAt.delete(path)
        }
      }
    }
  }

  // Returns true when the tab's file changed on disk without the watcher or our own save explaining it.
  const detectUnexplainedChange = async (file: OpenFile, snapshotKey: string): Promise<boolean> => {
    let stat: { mtime: number; size: number }
    try {
      stat = await deps.statFile(file)
    } catch {
      // Why: a missing or unreadable file is the watcher's delete/rename path, not this backstop's.
      return false
    }
    const polledAt = now()
    const previous = snapshots.get(snapshotKey)
    snapshots.set(snapshotKey, { mtime: stat.mtime, size: stat.size, polledAt })
    if (!previous || (previous.mtime === stat.mtime && previous.size === stat.size)) {
      return false
    }
    const watcherAt = watcherEventAt.get(normalizeRuntimePathForComparison(file.filePath))
    if (watcherAt !== undefined && watcherAt >= previous.polledAt) {
      return false
    }
    const selfWriteAt = deps.getLastSelfWriteAt(file.filePath)
    return !(selfWriteAt !== null && selfWriteAt >= previous.polledAt - SELF_WRITE_SLACK_MS)
  }

  const pollNow = async (): Promise<void> => {
    if (polling) {
      return
    }
    polling = true
    try {
      const openFiles = deps.getOpenFiles()
      const liveKeys = new Set<string>()
      for (const target of deps.getTargets()) {
        // Why: SSH and runtime-owned trees have their own watch transports; this backstop only covers files the client can stat directly.
        if (target.runtimeEnvironmentId || target.connectionId) {
          continue
        }
        const files = openFiles
          .filter((file) => file.worktreeId === target.worktreeId && isPollableFile(file))
          .slice(0, MAX_POLLED_FILES_PER_TARGET)
        const changed: OpenFile[] = []
        await Promise.all(
          files.map(async (file) => {
            const key = `${file.worktreeId}::${normalizeRuntimePathForComparison(file.filePath)}`
            liveKeys.add(key)
            if (await detectUnexplainedChange(file, key)) {
              changed.push(file)
            }
          })
        )
        if (changed.length > 0) {
          deps.handleFsChanged({
            worktreePath: target.worktreePath,
            events: changed.map((file) => ({ kind: 'update', absolutePath: file.filePath }))
          })
        }
      }
      for (const key of snapshots.keys()) {
        if (!liveKeys.has(key)) {
          snapshots.delete(key)
        }
      }
    } finally {
      polling = false
    }
  }

  const start = (): (() => void) => {
    const poll = (): void => {
      void pollNow()
    }
    const pollIfVisible = (): void => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        poll()
      }
    }
    const interval = globalThis.setInterval(pollIfVisible, EDITOR_EXTERNAL_WATCH_POLL_INTERVAL_MS)
    // Why: a change made while the app was in the background is surfaced the moment the user returns, not up to a full interval later.
    window.addEventListener('focus', poll)
    document.addEventListener('visibilitychange', pollIfVisible)
    return () => {
      globalThis.clearInterval(interval)
      window.removeEventListener('focus', poll)
      document.removeEventListener('visibilitychange', pollIfVisible)
    }
  }

  return { pollNow, noteWatcherPayload, start }
}
