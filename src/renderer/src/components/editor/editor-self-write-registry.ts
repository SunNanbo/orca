import { normalizeAbsolutePathForComparison } from '@/components/right-sidebar/file-explorer-paths'
import { MAX_TIMER_DELAY_MS } from '../../../../shared/timer-delay'

// Self-write echoes can reload TipTap, resetting selection and dropping typing; bound owner/path stamps so later external edits remain visible.
const SELF_WRITE_TTL_MS = 750
// Remote watcher polling and network delays outlast the local echo window.
export const SELF_WRITE_REMOTE_TTL_MS = 3000
const SELF_WRITE_MAX_STAMPS = 256

export type RecentSelfWrite = {
  content: string | null
}

type SelfWriteStamp = RecentSelfWrite & {
  expiresAt: number
}

const stamps = new Map<string, SelfWriteStamp>()
// Why: the stamp TTL is far shorter than a poll interval, so the poll backstop needs a longer-lived "we wrote this" signal to tell our own save from an external one.
const lastSelfWriteAt = new Map<string, number>()
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let scheduledExpiryAt = Infinity

function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
  scheduledExpiryAt = Infinity
}

function scheduleExpiredSelfWriteCleanup(): void {
  let nextExpiryAt = Infinity
  for (const stamp of stamps.values()) {
    if (Number.isFinite(stamp.expiresAt)) {
      nextExpiryAt = Math.min(nextExpiryAt, stamp.expiresAt + 1)
    }
  }
  if (nextExpiryAt === Infinity) {
    clearExpiryTimer()
    return
  }
  if (expiryTimer !== null && scheduledExpiryAt <= nextExpiryAt) {
    return
  }
  clearExpiryTimer()
  scheduledExpiryAt = nextExpiryAt
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null
      scheduledExpiryAt = Infinity
      pruneExpiredSelfWrites()
      scheduleExpiredSelfWriteCleanup()
    },
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextExpiryAt - Date.now()))
  )
}

function selfWriteKey(absolutePath: string, runtimeEnvironmentId?: string | null): string {
  return `${runtimeEnvironmentId?.trim() || 'client'}::${normalizeAbsolutePathForComparison(absolutePath)}`
}

function pruneExpiredSelfWrites(now = Date.now()): void {
  for (const [key, stamp] of stamps) {
    if (now > stamp.expiresAt) {
      stamps.delete(key)
    }
  }
}

function enforceSelfWriteStampLimit(): void {
  while (stamps.size > SELF_WRITE_MAX_STAMPS) {
    const oldest = stamps.keys().next().value
    if (oldest === undefined) {
      break
    }
    stamps.delete(oldest)
  }
}

export function recordSelfWrite(
  absolutePath: string,
  content?: string,
  runtimeEnvironmentId?: string | null,
  ttlMs: number = SELF_WRITE_TTL_MS
): void {
  const now = Date.now()
  pruneExpiredSelfWrites(now)
  const key = selfWriteKey(absolutePath, runtimeEnvironmentId)
  // Bound retention even when no watcher echo arrives.
  stamps.delete(key)
  stamps.set(key, {
    content: content ?? null,
    expiresAt: now + ttlMs
  })
  enforceSelfWriteStampLimit()
  scheduleExpiredSelfWriteCleanup()
  lastSelfWriteAt.delete(key)
  lastSelfWriteAt.set(key, now)
  while (lastSelfWriteAt.size > SELF_WRITE_MAX_STAMPS) {
    const oldest = lastSelfWriteAt.keys().next().value
    if (oldest === undefined) {
      break
    }
    lastSelfWriteAt.delete(oldest)
  }
}

export function getLastSelfWriteAt(
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): number | null {
  return lastSelfWriteAt.get(selfWriteKey(absolutePath, runtimeEnvironmentId)) ?? null
}

export function clearSelfWrite(absolutePath: string, runtimeEnvironmentId?: string | null): void {
  stamps.delete(selfWriteKey(absolutePath, runtimeEnvironmentId))
  if (stamps.size === 0) {
    clearExpiryTimer()
  }
}

export function getRecentSelfWrite(
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): RecentSelfWrite | null {
  const key = selfWriteKey(absolutePath, runtimeEnvironmentId)
  const stamp = stamps.get(key)
  if (!stamp) {
    return null
  }
  if (Date.now() > stamp.expiresAt) {
    stamps.delete(key)
    if (stamps.size === 0) {
      clearExpiryTimer()
    }
    return null
  }
  return { content: stamp.content }
}

export function hasRecentSelfWrite(
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): boolean {
  return getRecentSelfWrite(absolutePath, runtimeEnvironmentId) !== null
}

export function __clearSelfWriteRegistryForTests(): void {
  clearExpiryTimer()
  stamps.clear()
  lastSelfWriteAt.clear()
}

export function __getSelfWriteRegistrySizeForTests(): number {
  return stamps.size
}
