import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { GitInfo, QuotaReading, QuotaWindow, Words } from '../types'

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


// The language the band's words are in, as a key (`ja`, `en`, `fr`, `zh-tw`, or a
// language name): Claude Code's (every surface), and the desktop app's display
// language, which the desktop Code tab prefers
const language = atom({ plugin: 'context-git-band', key: 'language' } as const, null)
const appLanguage = atom({ plugin: 'context-git-band', key: 'appLanguage' } as const, null)
// Tables translated from EN, by language key
const translations = atom({ plugin: 'context-git-band', key: 'translations' } as const, null)

// How often a change of either is picked up
const LANGUAGE_CHECK_MS = 3_000

// The band's own words as templates; `{name}` is filled in. Japanese and English
// are written here; any other language is translated from English once (see
// ensureWords). The weather names and the short labels (Hide, compact) stay English.
const EN: Words = {
  week: 'wk',
  quotaAlt: '{label} {remaining}% left',
  uncommitted: '{count} uncommitted',
  commitPrompt: 'Commit the uncommitted changes',
  clean: '✔ clean',
  noUpstream: 'no upstream',
  notOnGitHub: 'not on GitHub',
  unpushed: '↑{count} unpushed',
  compactSoon: 'Context {used}/{window}: compact soon',
  compactSkipped: 'compact skipped: {reason}',
  compactFailed: 'compact could not run now',
}

const JA: Words = {
  week: '週',
  quotaAlt: '{label} 残{remaining}%',
  uncommitted: '{count} 未コミット',
  commitPrompt: '未コミットの変更をコミットして',
  clean: '✔ クリーン',
  noUpstream: 'upstreamなし',
  notOnGitHub: 'GitHub未公開',
  unpushed: '↑{count} 未push',
  compactSoon: 'コンテキスト {used}/{window}：そろそろ compact',
  compactSkipped: 'compact を見送りました：{reason}',
  compactFailed: '今は compact できません',
}

const WRITTEN: Record<string, Words> = { en: EN, ja: JA }

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))

const wordsFor = (key: string | null, translated: Record<string, Words> | null) =>
  (key === null ? undefined : (WRITTEN[key] ?? translated?.[key])) ?? EN

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
    const { exitCode, stdout } = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v1', '-b'], {
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
// - the account usage endpoint (undocumented), polled (every session's use)
// The newer reading wins. Polls are shared across sessions through `$.store`,
// so any number of open sessions makes the requests of one.

const quota = atom({ plugin: 'context-git-band', key: 'quota' } as const, null)

// Undocumented and may change; it answers 429 to aggressive polling
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
const POLL_GAP_MS = 180_000
const EVENT_GAP_MS = 60_000
const CHECK_EVERY_MS = 30_000
const MAX_BACKOFF_MS = 900_000
// How long a session that started a request keeps the others from starting one
const CLAIM_MS = 15_000

const KINDS = ['five_hour', 'seven_day']

// Two store keys, so no writer overwrites the other's part: the newest reading
// (this session's responses and every poll write it) and the poll's own
// bookkeeping (only a poll writes it)
const READING_KEY = 'quota:reading'
const POLL_KEY = 'quota:poll'

type Poll = { fetchedAt: number; failures: number; nextAt: number; claim: { until: number; token: string } | null }

const NO_POLL: Poll = { fetchedAt: 0, failures: 0, nextAt: 0, claim: null }

const loadPoll = async ($: EngineInterface): Promise<Poll> => {
  const value = await $.store.get(POLL_KEY)
  return typeof value === 'object' && value !== null ? { ...NO_POLL, ...(value as Partial<Poll>) } : { ...NO_POLL }
}

const loadReading = async ($: EngineInterface): Promise<QuotaReading | null> => {
  const value = (await $.store.get(READING_KEY)) as QuotaReading | undefined
  return value !== undefined && Array.isArray(value.windows) && typeof value.at === 'number' ? value : null
}

const isNewer = (next: QuotaReading, current: QuotaReading | null | undefined) =>
  current === null || current === undefined || next.at > current.at

const adopt = ($: EngineInterface, reading: QuotaReading) =>
  update($, quota, current => (isNewer(reading, current) ? reading : current))

// Shares a reading unless the store already holds a newer one
async function shareReading($: EngineInterface, reading: QuotaReading) {
  if (isNewer(reading, await loadReading($))) await $.store.set(READING_KEY, reading)
}

// A reading from this session's own API responses: shown at once and shared
async function takeLive($: EngineInterface, rateLimits: SessionRateLimit[]) {
  const windows: QuotaWindow[] = rateLimits
    .filter(limit => KINDS.includes(limit.kind))
    .map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
  if (windows.length === 0) return
  const reading = { windows, at: await $.clock.now() }
  await adopt($, reading)
  await shareReading($, reading)
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

let isPolling = false

// Takes what another session shared, then polls when `gapMs` has passed since
// the last poll and no backoff or other session's request stands in the way.
// The store has no compare-and-set: a session writes a claim with its own token
// and goes ahead only if that token reads back, which narrows (not closes) the
// window in which two sessions both poll.
async function syncQuota($: EngineInterface, gapMs: number) {
  const shared = await loadReading($)
  if (shared !== null) await adopt($, shared)
  if (isPolling) return
  isPolling = true
  try {
    const poll = await loadPoll($)
    const now = await $.clock.now()
    if (now < poll.nextAt || (poll.claim !== null && now < poll.claim.until) || now - poll.fetchedAt < gapMs) return

    // A subscription signs in with a bearer token; an API key has no such quota
    const auth = await $.session.authorize()
    if (auth === null || auth.kind !== 'bearer') return

    const token = `${now}-${Math.random().toString(36).slice(2)}`
    await $.store.set(POLL_KEY, { ...poll, claim: { until: now + CLAIM_MS, token } })
    if ((await loadPoll($)).claim?.token !== token) return

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

    const latest = await loadPoll($)
    if (reading === null) {
      const failures = latest.failures + 1
      await $.store.set(POLL_KEY, {
        failures,
        fetchedAt: now,
        nextAt: now + Math.min(POLL_GAP_MS * 2 ** (failures - 1), MAX_BACKOFF_MS),
        claim: null,
      })
      return
    }
    await $.store.set(POLL_KEY, { fetchedAt: now, failures: 0, nextAt: 0, claim: null })
    await shareReading($, reading)
    await adopt($, reading)
  } finally {
    isPolling = false
  }
}

const remainingOf = (reading: QuotaReading | null) =>
  (reading?.windows ?? []).map(({ kind, percentUsed }) => ({
    kind,
    remaining: Math.max(0, Math.min(100, Math.round(100 - percentUsed))),
  }))

// `/compact`'s own call; refused while a turn runs, so the link shows only between
// turns. The module flag is set before any await, so a second press does nothing.
let isCompactRunning = false

async function compactNow($: EngineInterface) {
  if (isCompactRunning) return
  isCompactRunning = true
  try {
    await update($, isCompacting, () => true)
    let note: string | undefined
    try {
      const result = await $.session.compact()
      if (result.skip !== undefined) note = fill((await toastWords($)).compactSkipped, { reason: result.skip })
    } catch {
      note = (await toastWords($)).compactFailed
    }
    if (note !== undefined) $.ui.toast(note)
  } finally {
    isCompactRunning = false
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

// A language as a key: `ja` and `en` for the written tables, else a lowercased
// locale tag (`fr`, `pt-br`, `zh-tw`, `sr-latin`) or language name (`french`);
// null when it names no language (`C`, `POSIX`, a bare `UTF-8`)
const languageKey = (raw: string): string | null => {
  const lowered = raw.trim().toLowerCase()
  // A locale's modifier names its script (sr_RS@latin); its encoding names nothing
  const modifier = /@([a-z]+)/.exec(lowered)?.[1]
  const text = lowered.replace(/[.@].*$/, '').replace(/_/g, '-')
  if (text === '' || text === 'c' || text === 'posix' || /^utf-?8$/.test(text)) return null
  if (/^(japanese|日本語)/.test(text) || /^ja(?:$|-)/.test(text)) return 'ja'
  if (/^english/.test(text) || /^en(?:$|-)/.test(text)) return 'en'
  const tag = /^([a-z]{2,3})(?:-([a-z0-9]+))?$/.exec(text)
  if (tag === null) return text
  const [, base = text, region] = tag
  // Keep what changes the written language: zh-tw/zh-hant, pt-br, a script modifier
  if (modifier !== undefined) return `${base}-${modifier}`
  return region !== undefined && (base === 'zh' || base === 'pt') ? `${base}-${region}` : base
}

// `auto` follows Claude Code's own `language` setting (the language Claude replies
// in), then the locale variables; English with nothing to go by
async function claudeLanguage($: EngineInterface): Promise<string> {
  const { language: replyLanguage } = (await $.settings.read()) as { language?: unknown }
  const fromSetting = typeof replyLanguage === 'string' ? languageKey(replyLanguage) : null
  if (fromSetting !== null) return fromSetting
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG')) || ''
  return languageKey(locale) ?? 'en'
}

// The desktop app keeps its display language as `locale` in its own config.json,
// an internal file that also holds its sign-in cache: read again only when its
// mtime moves, and nothing but `locale` kept. Null where there is no such app.
let appConfigMtime = -1

async function readAppLanguage($: EngineInterface): Promise<string | null | undefined> {
  const home = await $.env.get('HOME')
  if (home === undefined) return null
  const path = `${home}/Library/Application Support/Claude/config.json`
  try {
    const { mtimeMs } = await $.fs.stat(path)
    if (mtimeMs === appConfigMtime) return undefined
    appConfigMtime = mtimeMs
    const { locale } = JSON.parse(String(await $.fs.read(path))) as { locale?: unknown }
    return typeof locale === 'string' ? languageKey(locale) : null
  } catch {
    return null
  }
}

// A translated table is kept in the store per language, stamped with the English
// it came from, so a change of EN translates again
const hashText = (text: string) => {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}
const EN_VERSION = hashText(JSON.stringify(EN))
const TRANSLATE_CLAIM_MS = 60_000
const translating = new Set<string>()

const placeholders = (template: string) => (template.match(/\{\w+\}/g) ?? []).sort().join()

// A translation is taken whole or not at all: every key, every placeholder, one
// line each, and no longer than the band can hold
const checkWords = (value: unknown): Words | null => {
  if (typeof value !== 'object' || value === null) return null
  const table = value as Record<string, unknown>
  for (const key of Object.keys(EN) as (keyof Words)[]) {
    const text = table[key]
    if (typeof text !== 'string' || text.trim() === '' || /[\n\[\]]/.test(text)) return null
    if (placeholders(text) !== placeholders(EN[key])) return null
    if (text.length > Math.max(24, EN[key].length * 2.5)) return null
  }
  return Object.fromEntries((Object.keys(EN) as (keyof Words)[]).map(key => [key, String(table[key])])) as Words
}

// A language's table as kept: its words, or `failed` when its translation did not
// hold, which keeps that language in English
type StoredWords = { version: string; words?: Words; failed?: true }

// Makes the table for `key` ready: written, already translated, kept in the
// store, or translated now by one small model call (the band shows English
// until it lands). A failure fixes English for that language, in every session,
// until the English words change; nothing is tried again before then.
async function ensureWords($: EngineInterface, key: string | null) {
  if (key === null || key in WRITTEN || translating.has(key)) return
  translating.add(key)
  let claimKey: string | undefined
  let isDone = false
  const storeKey = `words:${key}`
  try {
    if ((await read($, translations))?.[key] !== undefined) return
    const stored = (await $.store.get(storeKey)) as Partial<StoredWords> | undefined
    if (stored?.version === EN_VERSION && stored.failed === true) return
    const kept = stored?.version === EN_VERSION ? checkWords(stored.words) : null
    if (kept !== null) {
      await update($, translations, current => ({ ...current, [key]: kept }))
      return
    }
    const now = await $.clock.now()
    const claim = `translating:${key}`
    if (Number((await $.store.get(claim)) ?? 0) > now) return
    await $.store.set(claim, now + TRANSLATE_CLAIM_MS)
    claimKey = claim
    const result = await $.model.complete({
      model: 'haiku',
      system: 'You translate the user interface strings of a one-line status bar in a developer tool.',
      prompt:
        `Translate the values of this JSON object into the language "${key}" (a language name or a locale tag). ` +
        'Keep every key. Keep each {placeholder} exactly as written. Keep the ✔ and ↑ marks, and keep 5h, GitHub, ' +
        'upstream, push and compact as they are. Make each value as short as a status bar needs. ' +
        'Answer with the JSON object only.\n\n' +
        JSON.stringify(EN),
      maxTokens: 1024,
      timeoutMs: 30_000,
    })
    if (!result.isAnswered) return
    const json = /\{[\s\S]*\}/.exec(result.text)?.[0]
    const words = json === undefined ? null : checkWords(JSON.parse(json))
    if (words === null) return
    await $.store.set(storeKey, { version: EN_VERSION, words })
    await update($, translations, current => ({ ...current, [key]: words }))
    isDone = true
  } catch {
    // English stays
  } finally {
    translating.delete(key)
    if (claimKey !== undefined) {
      await $.store.delete(claimKey).catch(() => undefined)
      if (!isDone) await $.store.set(storeKey, { version: EN_VERSION, failed: true }).catch(() => undefined)
    }
  }
}

// Settles both languages and makes their tables ready; `ja` or `en` in the
// option fixes them on every surface
async function refreshLanguage($: EngineInterface, option: unknown) {
  if (option === 'ja' || option === 'en') {
    await update($, language, () => option)
    await update($, appLanguage, () => null)
    return
  }
  const claude = await claudeLanguage($)
  await update($, language, current => (current === claude ? current : claude))
  const app = await readAppLanguage($)
  if (app !== undefined) await update($, appLanguage, current => (current === app ? current : app))
  void ensureWords($, claude)
  void ensureWords($, await read($, appLanguage))
}

// Toasts follow the band's rule: the desktop app's language only when the
// session draws on the desktop alone, Claude Code's otherwise
async function toastWords($: EngineInterface) {
  const surfaces = await $.session.surfaces()
  const isDesktopOnly = surfaces.length > 0 && surfaces.every(surface => surface === 'desktop')
  const app = isDesktopOnly ? await read($, appLanguage) : null
  return wordsFor(app ?? (await read($, language)), await read($, translations))
}

export const register: Register = (on, options) => {

  on('session.start', async ($, e, next) => {
    // A reload in the middle of a compaction leaves the flag behind
    await update($, isCompacting, () => false)
    await refreshLanguage($, options.language)
    $.clock.every(LANGUAGE_CHECK_MS, () => void refreshLanguage($, options.language).catch(() => undefined))
    await refreshGit($, true)
    // A reload drops the old timer with the old module
    $.clock.every(CHECK_EVERY_MS, () => void syncQuota($, POLL_GAP_MS).catch(() => undefined))
    void syncQuota($, EVENT_GAP_MS).catch(() => undefined)
    await refreshCompactAt($)

    return next(e)
  })

  // A `/config` change of Claude Code's language shows at once
  on('config.set', async ($, e, next) => {
    const result = await next(e)
    await refreshLanguage($, options.language).catch(() => undefined)

    return result
  }).catch(($, e, next) => next(e))

  // Git is read in the background, so a prompt or a tool result never waits on it
  on('prompt.submit', ($, e, next) => {
    void refreshGit($, false).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (EDITING_TOOLS.includes(e.tool)) void refreshGit($, false).catch(() => undefined)

    return result
  }).catch(($, e, next) => next(e))

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
      $.ui.toast(fill((await toastWords($)).compactSoon, { used: kilo(tokens), window: kilo(context.window) }))
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
    const claude = await read($, language)
    const app = e.surface === 'desktop' ? await read($, appLanguage) : null
    const t = wordsFor(app ?? claude, await read($, translations))
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
    const quotas = remainingOf(await read($, quota)).map(q => ({ ...q, label: q.kind === 'seven_day' ? t.week : q.kind === 'five_hour' ? '5h' : q.kind }))

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
                        alt={fill(t.quotaAlt, { label: q.label, remaining: q.remaining })}
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
                    label={fill(t.uncommitted, { count: info.dirty })}
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
                  <Text color="yellow"> · {fill(t.unpushed, { count: info.ahead })}</Text>
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
