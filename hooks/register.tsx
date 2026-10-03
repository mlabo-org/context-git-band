import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { GitInfo, QuotaReading, QuotaWindow } from '../types'

const git = atom({ plugin: 'context-git-band', key: 'git' } as const, null)
const isHidden = atom({ plugin: 'context-git-band', key: 'isHidden' } as const, false)

// The context window's fill as weather, with the guide's thresholds
const weather = (percent: number) => {
  if (percent >= 90) return { icon: '↯', label: 'Compact Soon', color: 'red' }
  if (percent >= 75) return { icon: '☇', label: 'Storm', color: 'red' }
  if (percent >= 50) return { icon: '☂', label: 'Showers', color: 'yellow' }
  if (percent >= 25) return { icon: '☁', label: 'Cloudy', color: 'cyan' }
  return { icon: '☀', label: 'Clear', color: 'green' }
}

const kilo = (n: number) => `${Math.round(n / 1000)}k`

// Subscription windows shown as remaining percent, like mini-system-monitor-rs
const QUOTA_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '週' }

const quotaColor = (remaining: number) => (remaining <= 10 ? 'red' : remaining <= 25 ? 'yellow' : undefined)

// `git status --porcelain=v1 -b`: first line is the branch, the rest are changed files
const parseStatus = (stdout: string): GitInfo => {
  const [head = '', ...rest] = stdout.split('\n').filter(line => line !== '')
  const branchLine = head.replace(/^## /, '')
  const name = branchLine.split('...')[0] ?? branchLine
  const hasUpstream = branchLine.includes('...')
  const ahead = /ahead (\d+)/.exec(branchLine)
  const behind = /behind (\d+)/.exec(branchLine)

  return {
    branch: name.startsWith('No commits yet on ') ? name.slice(18) : name,
    dirty: rest.length,
    ahead: hasUpstream ? (ahead ? Number(ahead[1]) : 0) : null,
    behind: behind ? Number(behind[1]) : 0,
    otherHostOnly: false,
  }
}

// True when the repo has remotes and none of them is on GitHub
const hasOnlyOtherHost = (remotes: string) => {
  const urls = remotes.split('\n').filter(line => line.trim() !== '')
  return urls.length > 0 && !urls.some(line => line.includes('github.com'))
}

const EDITING_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit']

let lastRefresh = 0

// Reads git into the shared value; a folder that is not a repo, or a host
// that cannot run commands, leaves the band showing the context part alone.
async function refreshGit($: EngineInterface, force: boolean) {
  const now = await $.clock.now()
  if (!force && now - lastRefresh < 2000) return
  lastRefresh = now

  try {
    const { exitCode, stdout } = await $.process.run(['git', 'status', '--porcelain=v1', '-b'], {
      timeoutMs: 5000,
    })
    const info = exitCode === 0 ? parseStatus(stdout) : null
    if (info !== null && info.ahead === null) {
      const remotes = await $.process.run(['git', 'remote', '-v'], { timeoutMs: 5000 })
      info.otherHostOnly = remotes.exitCode === 0 && hasOnlyOtherHost(remotes.stdout)
    }
    await update($, git, () => info)
  } catch {
    await update($, git, () => null)
  }
}

// The subscription's 5-hour and weekly windows, from two sources:
// - this session's API responses, pushed by `session.measure` (instant, this session's use only)
// - the account usage endpoint mini-system-monitor-rs reads, polled (every session's use)
// The newer reading wins. Polls are shared across sessions through `$.store`,
// so any number of open sessions makes the requests of one.

const quota = atom({ plugin: 'context-git-band', key: 'quota' } as const, null)

// Undocumented and may change; it answers 429 to aggressive polling
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
const STORE_KEY = 'quota'
const POLL_GAP_MS = 180_000
const EVENT_GAP_MS = 60_000
const CHECK_EVERY_MS = 30_000
const MAX_BACKOFF_MS = 900_000
// How long a session that started a request keeps the others from starting one
const CLAIM_MS = 15_000

const KINDS = ['five_hour', 'seven_day']

type Shared = {
  reading: QuotaReading | null
  fetchedAt: number
  failures: number
  nextAt: number
  claimedUntil: number
}

const EMPTY: Shared = { reading: null, fetchedAt: 0, failures: 0, nextAt: 0, claimedUntil: 0 }

const loadShared = async ($: EngineInterface): Promise<Shared> => {
  const value = await $.store.get(STORE_KEY)
  return typeof value === 'object' && value !== null ? { ...EMPTY, ...(value as Partial<Shared>) } : { ...EMPTY }
}

const isNewer = (next: QuotaReading, current: QuotaReading | null | undefined) =>
  current === null || current === undefined || next.at > current.at

const adopt = ($: EngineInterface, reading: QuotaReading) =>
  update($, quota, current => (isNewer(reading, current) ? reading : current))

// A reading from this session's own API responses: shown at once and shared
async function takeLive($: EngineInterface, rateLimits: SessionRateLimit[]) {
  const windows: QuotaWindow[] = rateLimits
    .filter(limit => KINDS.includes(limit.kind))
    .map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
  if (windows.length === 0) return
  const reading = { windows, at: await $.clock.now() }
  await adopt($, reading)
  const shared = await loadShared($)
  if (isNewer(reading, shared.reading)) await $.store.set(STORE_KEY, { ...shared, reading })
}

type UsageWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined

const parseUsage = (text: string, at: number): QuotaReading | null => {
  const body = JSON.parse(text) as Record<string, UsageWindow>
  const windows = KINDS.flatMap(kind => {
    const window = body[kind]
    return typeof window?.utilization === 'number'
      ? [{ kind, percentUsed: window.utilization, resetsAt: window.resets_at ?? undefined }]
      : []
  })
  return windows.length === 0 ? null : { windows, at }
}

// Takes what another session fetched, then polls when `gapMs` has passed since
// the last poll and no backoff or other session's request stands in the way
async function syncQuota($: EngineInterface, gapMs: number) {
  const shared = await loadShared($)
  if (shared.reading !== null) await adopt($, shared.reading)

  const now = await $.clock.now()
  if (now < shared.nextAt || now < shared.claimedUntil || now - shared.fetchedAt < gapMs) return

  // A subscription signs in with a bearer token; an API key has no such quota
  const auth = await $.session.authorize()
  if (auth === null || auth.kind !== 'bearer') return

  await $.store.set(STORE_KEY, { ...shared, claimedUntil: now + CLAIM_MS })
  let reading: QuotaReading | null = null
  try {
    const response = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': OAUTH_BETA, Accept: 'application/json' },
    })
    if (response.ok) reading = parseUsage(response.text, now)
  } catch {
    reading = null
  }

  const latest = await loadShared($)
  if (reading === null) {
    const failures = shared.failures + 1
    await $.store.set(STORE_KEY, {
      ...latest,
      failures,
      fetchedAt: now,
      nextAt: now + Math.min(POLL_GAP_MS * 2 ** (failures - 1), MAX_BACKOFF_MS),
      claimedUntil: 0,
    })
    return
  }

  await $.store.set(STORE_KEY, {
    reading: isNewer(reading, latest.reading) ? reading : latest.reading,
    fetchedAt: now,
    failures: 0,
    nextAt: 0,
    claimedUntil: 0,
  })
  await adopt($, reading)
}

const remainingOf = (reading: QuotaReading | null) =>
  (reading?.windows ?? []).map(({ kind, percentUsed }) => ({
    kind,
    remaining: Math.max(0, Math.min(100, Math.round(100 - percentUsed))),
  }))

let hasWarned = false

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await refreshGit($, true)
    // A reload drops the old timer with the old module
    $.clock.every(CHECK_EVERY_MS, () => void syncQuota($, POLL_GAP_MS).catch(() => undefined))
    void syncQuota($, EVENT_GAP_MS).catch(() => undefined)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await refreshGit($, false)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (EDITING_TOOLS.includes(e.tool)) await refreshGit($, false)

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await takeLive($, e.rateLimits)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refreshGit($, true)
    void syncQuota($, EVENT_GAP_MS).catch(() => undefined)

    const { context } = await $.session.usage()
    const percent = context.percent ?? 0
    if (percent >= 90 && !hasWarned) {
      hasWarned = true
      $.ui.toast(`Context ${percent}% full: compact soon`)
    } else if (percent < 80) {
      hasWarned = false
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    // Hidden: leave one small button that brings the band back
    if (await read($, isHidden)) {
      const beneath = await next(e)

      return (
        <Box flexDirection="column">
          <Box>
            <Button key="show" label="▸ ctx/git" onPress={() => update($, isHidden, () => false)} />
          </Box>
          {beneath ?? null}
        </Box>
      )
    }

    const { context } = await $.session.usage()
    const info = await read($, git)
    const quotas = remainingOf(await read($, quota)).map(q => ({ ...q, label: QUOTA_LABELS[q.kind] ?? q.kind }))

    const hasContext = context.percent !== undefined
    const w = weather(context.percent ?? 0)
    // The band is one site shared by every plugin: keep what the ones beneath draw
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box>
          {hasContext ? (
            <Text color={w.color}>
              {w.icon} {w.label} {context.percent}%{' '}
            </Text>
          ) : (
            <Text dimColor>ctx -- </Text>
          )}
          {hasContext && context.tokens !== undefined ? (
            <Text dimColor>
              ({kilo(context.tokens)}/{kilo(context.window)}){' '}
            </Text>
          ) : null}
          {quotas.length === 0 ? null : (
            <Box>
              <Text dimColor>│ </Text>
              {quotas.map(q => (
                <Text key={q.label} color={quotaColor(q.remaining)}>
                  {q.label} 残{q.remaining}%{' '}
                </Text>
              ))}
            </Box>
          )}
          {info === null ? null : (
            <Box>
              <Text dimColor>│ </Text>
              <Text bold>{info.branch}</Text>
              {info.dirty > 0 ? (
                <Box>
                  <Text color="yellow"> ● </Text>
                  <Button
                    key="commit"
                    label={`${info.dirty} 未コミット`}
                    onPress={() => void $.prompt.submit({ text: '未コミットの変更をコミットして', asUser: true })}
                  />
                </Box>
              ) : (
                <Text color="green"> ✔ クリーン</Text>
              )}
              <Text>
                {info.ahead === null ? (
                  <Text dimColor>{info.otherHostOnly ? ' · upstreamなし' : ' · GitHub未公開'}</Text>
                ) : info.ahead > 0 ? (
                  <Text color="yellow"> · ↑{info.ahead} 未push</Text>
                ) : null}
                {info.behind > 0 ? <Text color="cyan"> · ↓{info.behind}</Text> : null}
                <Text> </Text>
              </Text>
            </Box>
          )}
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {below ?? null}
      </Box>
    )
  })
}
