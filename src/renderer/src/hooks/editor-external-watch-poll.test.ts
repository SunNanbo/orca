// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import {
  EDITOR_EXTERNAL_WATCH_POLL_INTERVAL_MS,
  createEditorExternalWatchPoller
} from './editor-external-watch-poll'

const target: EditorExternalWatchTarget = {
  worktreeId: 'wt-1',
  worktreePath: 'G:/vault',
  connectionId: undefined,
  runtimeEnvironmentId: null
}

function file(overrides: Partial<OpenFile> = {}): OpenFile {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the poller only reads worktreeId, mode and filePath.
  return {
    id: 'G:/vault/note.md',
    worktreeId: 'wt-1',
    filePath: 'G:/vault/note.md',
    relativePath: 'note.md',
    mode: 'edit',
    ...overrides
  } as OpenFile
}

function setup(options: { files?: OpenFile[]; targets?: EditorExternalWatchTarget[] } = {}) {
  const stats = new Map<string, { mtime: number; size: number }>()
  let clock = 1_000
  const handleFsChanged = vi.fn<(payload: FsChangedPayload) => void>()
  const selfWrites = new Map<string, number>()
  const files = options.files ?? [file()]
  const poller = createEditorExternalWatchPoller({
    getTargets: () => options.targets ?? [target],
    getOpenFiles: () => files,
    statFile: async (f) => {
      const stat = stats.get(f.filePath)
      if (!stat) {
        throw new Error('ENOENT')
      }
      return stat
    },
    getLastSelfWriteAt: (path) => selfWrites.get(path) ?? null,
    handleFsChanged,
    now: () => clock
  })
  return {
    poller,
    handleFsChanged,
    stats,
    selfWrites,
    advance: (ms: number) => {
      clock += ms
    },
    files
  }
}

describe('editor external watch poll backstop', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records a baseline on first sight without reporting a change', async () => {
    const { poller, handleFsChanged, stats } = setup()
    stats.set('G:/vault/note.md', { mtime: 10, size: 5 })
    await poller.pollNow()
    expect(handleFsChanged).not.toHaveBeenCalled()
  })

  it('replays an in-place write that no watcher event reported as an update', async () => {
    const { poller, handleFsChanged, stats, advance } = setup()
    stats.set('G:/vault/note.md', { mtime: 10, size: 5 })
    await poller.pollNow()
    advance(3_000)
    stats.set('G:/vault/note.md', { mtime: 20, size: 5 })
    await poller.pollNow()
    expect(handleFsChanged).toHaveBeenCalledTimes(1)
    expect(handleFsChanged).toHaveBeenCalledWith({
      worktreePath: 'G:/vault',
      events: [{ kind: 'update', absolutePath: 'G:/vault/note.md' }]
    })
  })

  it('also reports a same-mtime size change and ignores an unchanged file', async () => {
    const { poller, handleFsChanged, stats, advance } = setup()
    stats.set('G:/vault/note.md', { mtime: 10, size: 5 })
    await poller.pollNow()
    advance(3_000)
    await poller.pollNow()
    expect(handleFsChanged).not.toHaveBeenCalled()
    advance(3_000)
    stats.set('G:/vault/note.md', { mtime: 10, size: 9 })
    await poller.pollNow()
    expect(handleFsChanged).toHaveBeenCalledTimes(1)
  })

  it('does not replay a change the real watcher already reported', async () => {
    const { poller, handleFsChanged, stats, advance } = setup()
    stats.set('G:/vault/note.md', { mtime: 10, size: 5 })
    await poller.pollNow()
    advance(1_000)
    poller.noteWatcherPayload({
      worktreePath: 'G:/vault',
      events: [{ kind: 'update', absolutePath: 'G:\\vault\\note.md' }]
    })
    advance(1_000)
    stats.set('G:/vault/note.md', { mtime: 20, size: 5 })
    await poller.pollNow()
    expect(handleFsChanged).not.toHaveBeenCalled()
  })

  it("does not treat the editor's own save as an external change", async () => {
    const { poller, handleFsChanged, stats, selfWrites, advance } = setup()
    stats.set('G:/vault/note.md', { mtime: 10, size: 5 })
    await poller.pollNow()
    advance(2_000)
    selfWrites.set('G:/vault/note.md', 2_500)
    stats.set('G:/vault/note.md', { mtime: 20, size: 8 })
    advance(1_000)
    await poller.pollNow()
    expect(handleFsChanged).not.toHaveBeenCalled()
    advance(3_000)
    stats.set('G:/vault/note.md', { mtime: 30, size: 9 })
    await poller.pollNow()
    expect(handleFsChanged).toHaveBeenCalledTimes(1)
  })

  it('skips ssh and runtime targets and non-editor tabs', async () => {
    const files = [file(), file({ id: 'd', filePath: 'G:/vault/d.md', mode: 'diff' })]
    const { poller, handleFsChanged, stats, advance } = setup({
      files,
      targets: [
        { ...target, connectionId: 'ssh-1' },
        { ...target, worktreeId: 'wt-2', runtimeEnvironmentId: 'env-1' },
        target
      ]
    })
    stats.set('G:/vault/note.md', { mtime: 10, size: 5 })
    stats.set('G:/vault/d.md', { mtime: 10, size: 5 })
    await poller.pollNow()
    advance(3_000)
    stats.set('G:/vault/note.md', { mtime: 20, size: 5 })
    stats.set('G:/vault/d.md', { mtime: 20, size: 5 })
    await poller.pollNow()
    expect(handleFsChanged).toHaveBeenCalledTimes(1)
    expect(handleFsChanged.mock.calls[0][0].events).toEqual([
      { kind: 'update', absolutePath: 'G:/vault/note.md' }
    ])
  })

  it('ignores stat failures instead of reporting them', async () => {
    const { poller, handleFsChanged, stats, advance } = setup()
    stats.set('G:/vault/note.md', { mtime: 10, size: 5 })
    await poller.pollNow()
    advance(3_000)
    stats.delete('G:/vault/note.md')
    await poller.pollNow()
    expect(handleFsChanged).not.toHaveBeenCalled()
  })

  it('polls on the interval and on window focus until torn down', async () => {
    vi.useFakeTimers()
    const statSpy = vi.fn()
    const countingPoller = createEditorExternalWatchPoller({
      getTargets: () => [target],
      getOpenFiles: () => [file()],
      statFile: async () => {
        statSpy()
        return { mtime: 10, size: 5 }
      },
      getLastSelfWriteAt: () => null,
      handleFsChanged: vi.fn()
    })
    const stop = countingPoller.start()
    await vi.advanceTimersByTimeAsync(EDITOR_EXTERNAL_WATCH_POLL_INTERVAL_MS)
    expect(statSpy).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(statSpy).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(EDITOR_EXTERNAL_WATCH_POLL_INTERVAL_MS * 2)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(statSpy).toHaveBeenCalledTimes(2)
  })
})
