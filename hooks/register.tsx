import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { GitInfo, Language, QuotaReading, QuotaWindow } from '../types'

const git = atom({ plugin: 'context-git-band', key: 'git' } as const, null)
const isHidden = atom({ plugin: 'context-git-band', key: 'isHidden' } as const, false)
const isCompacting = atom({ plugin: 'context-git-band', key: 'isCompacting' } as const, false)

// Tokens at which the weather turns into a link that compacts, and a toast says so
const compactAt = atom({ plugin: 'context-git-band', key: 'compactAt' } as const, null)

// Claude Code compacts on its own at its threshold (the window less 33k as measured:
// 167k of 200k, 967k of 1M). The link comes this many tokens earlier, so one or two
// heavy turns still fit before the automatic one runs mid-task.
const COMPACT_MARGIN_TOKENS = 50_000
// Never opened: the press is the plugin's (pressableLinks)
const COMPACT_HREF = 'http://localhost/compact'

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

// The language the band's words are in, settled at session start
const language = atom({ plugin: 'context-git-band', key: 'language' } as const, null)

// The band's words, by the `language` option (userConfig); the weather names stay English
const TEXT = {
  ja: {
    quota: { five_hour: '5h', seven_day: '週' } as Record<string, string>,
    quotaAlt: (label: string, remaining: number) => `${label} 残${remaining}%`,
    uncommitted: (count: number) => `${count} 未コミット`,
    commitPrompt: '未コミットの変更をコミットして',
    clean: '✔ クリーン',
    noUpstream: 'upstreamなし',
    notOnGitHub: 'GitHub未公開',
    unpushed: (count: number) => `↑${count} 未push`,
  },
  en: {
    quota: { five_hour: '5h', seven_day: 'wk' } as Record<string, string>,
    quotaAlt: (label: string, remaining: number) => `${label} ${remaining}% left`,
    uncommitted: (count: number) => `${count} uncommitted`,
    commitPrompt: 'Commit the uncommitted changes',
    clean: '✔ clean',
    noUpstream: 'no upstream',
    notOnGitHub: 'not on GitHub',
    unpushed: (count: number) => `↑${count} unpushed`,
  },
}

const quotaColor = (remaining: number) => (remaining <= 10 ? 'red' : remaining <= 25 ? 'yellow' : 'green')

// A gauge of the remaining percent, 10 cells, each split into eighths
const METER_CELLS = 10
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

const meterText = (remaining: number) => {
  const eighths = Math.round((remaining / 100) * METER_CELLS * 8)
  const full = Math.floor(eighths / 8)
  const partial = EIGHTHS[eighths % 8] ?? ''
  const filled = '█'.repeat(full) + partial
  return { filled, empty: '░'.repeat(METER_CELLS - full - (partial === '' ? 0 : 1)) }
}

// The desktop draws the gauge as a rounded bar; colors read on light and dark
const SVG_COLORS: Record<string, string> = { green: '#2ea043', yellow: '#d29922', red: '#e5534b' }
const METER_WIDTH = 64
const METER_HEIGHT = 8

const meterSvg = (remaining: number) => {
  const fill = Math.round((remaining / 100) * METER_WIDTH)
  const r = METER_HEIGHT / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${METER_WIDTH}" height="${METER_HEIGHT}" viewBox="0 0 ${METER_WIDTH} ${METER_HEIGHT}">` +
    `<clipPath id="c"><rect width="${METER_WIDTH}" height="${METER_HEIGHT}" rx="${r}"/></clipPath>` +
    `<g clip-path="url(#c)"><rect width="${METER_WIDTH}" height="${METER_HEIGHT}" fill="#8b949e" fill-opacity="0.3"/>` +
    `<rect width="${fill}" height="${METER_HEIGHT}" fill="${SVG_COLORS[quotaColor(remaining)]}"/></g></svg>`
  )
}

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

// `/compact`'s own call; refused while a turn runs, so the link shows only between turns
async function compactNow($: EngineInterface) {
  if (await read($, isCompacting)) return
  await update($, isCompacting, () => true)
  try {
    const result = await $.session.compact()
    if (result.skip !== undefined) $.ui.toast(`compact skipped: ${result.skip}`)
  } catch {
    $.ui.toast('compact could not run now')
  } finally {
    await update($, isCompacting, () => false)
  }
}

// The engine's own threshold, read off the /context breakdown (estimated
// locally, no request); with auto-compaction off the window is the limit
async function refreshCompactAt($: EngineInterface) {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const limit = context.breakdown?.autoCompactThreshold ?? context.window
  await update($, compactAt, () => Math.max(0, limit - COMPACT_MARGIN_TOKENS))
}

let hasWarned = false

// `auto` follows Claude Code's own `language` setting (the language Claude replies
// in), then the locale variables; Japanese only when one of them says so
async function resolveLanguage($: EngineInterface, option: unknown): Promise<Language> {
  if (option === 'ja' || option === 'en') return option
  const { language: replyLanguage } = (await $.settings.read()) as { language?: unknown }
  if (typeof replyLanguage === 'string' && replyLanguage.trim() !== '') {
    return /^(ja|japanese|日本語)/i.test(replyLanguage.trim()) ? 'ja' : 'en'
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG')) || ''
  return /^ja/i.test(locale) ? 'ja' : 'en'
}

export const register: Register = (on, options) => {

  on('session.start', async ($, e, next) => {
    const settled = await resolveLanguage($, options.language)
    await update($, language, () => settled)
    await refreshGit($, true)
    // A reload drops the old timer with the old module
    $.clock.every(CHECK_EVERY_MS, () => void syncQuota($, POLL_GAP_MS).catch(() => undefined))
    void syncQuota($, EVENT_GAP_MS).catch(() => undefined)
    await refreshCompactAt($)

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

    await refreshCompactAt($)
    const { context } = await $.session.usage()
    const at = await read($, compactAt)
    const tokens = context.tokens ?? 0
    if (at !== null && tokens >= at && !hasWarned) {
      hasWarned = true
      $.ui.toast(`Context ${kilo(tokens)}/${kilo(context.window)}: compact soon`)
    } else if (at !== null && tokens < at) {
      hasWarned = false
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const t = TEXT[(await read($, language)) ?? 'en']
    const { Box, Button, Markdown, Text } = elements
    const Svg = e.surface === 'desktop' && 'Svg' in elements ? elements.Svg : undefined

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
    const quotas = remainingOf(await read($, quota)).map(q => ({ ...q, label: t.quota[q.kind] ?? q.kind }))

    const hasContext = context.percent !== undefined
    const w = weather(context.percent ?? 0)
    const compacting = await read($, isCompacting)
    const at = await read($, compactAt)
    const canCompact =
      at !== null && context.tokens !== undefined && context.tokens >= at && !e.props.isWorking && !compacting
    const tokensText =
      hasContext && context.tokens !== undefined ? ` (${kilo(context.tokens)}/${kilo(context.window)})` : ''
    // The band is one site shared by every plugin: keep what the ones beneath draw
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box>
          {compacting ? (
            <Text color="cyan">⟳ Compacting… </Text>
          ) : canCompact ? (
            <Markdown
              key="compact"
              text={`[${w.icon} ${w.label} ${context.percent}%${tokensText} ⟲ compact](${COMPACT_HREF})`}
              onLinkPress={() => void compactNow($)}
              pressableLinks={[COMPACT_HREF]}
            />
          ) : hasContext ? (
            <Box>
              <Text color={w.color}>
                {w.icon} {w.label} {context.percent}%{' '}
              </Text>
              {tokensText === '' ? null : <Text dimColor>{tokensText.trim()} </Text>}
            </Box>
          ) : (
            <Text dimColor>ctx -- </Text>
          )}
          {quotas.length === 0 ? null : (
            <Box>
              <Text dimColor>│ </Text>
              {quotas.map(q => {
                const color = quotaColor(q.remaining)
                const meter = meterText(q.remaining)
                return (
                  <Box key={q.label}>
                    <Text>{q.label} </Text>
                    {Svg === undefined ? (
                      <Text>
                        <Text color={color}>{meter.filled}</Text>
                        <Text dimColor>{meter.empty}</Text>
                      </Text>
                    ) : (
                      <Svg
                        source={meterSvg(q.remaining)}
                        alt={t.quotaAlt(q.label, q.remaining)}
                        width={METER_WIDTH}
                        height={METER_HEIGHT}
                      />
                    )}
                    <Text color={color}> {q.remaining}% </Text>
                  </Box>
                )
              })}
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
                    label={t.uncommitted(info.dirty)}
                    onPress={() => void $.prompt.submit({ text: t.commitPrompt, asUser: true })}
                  />
                </Box>
              ) : (
                <Text color="green"> {t.clean}</Text>
              )}
              <Text>
                {info.ahead === null ? (
                  <Text dimColor>{info.otherHostOnly ? ` · ${t.noUpstream}` : ` · ${t.notOnGitHub}`}</Text>
                ) : info.ahead > 0 ? (
                  <Text color="yellow"> · {t.unpushed(info.ahead)}</Text>
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
