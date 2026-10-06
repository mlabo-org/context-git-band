import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const CONTEXT = { tokens: 62_000, window: 200_000, percent: 31 }

// A repo on main with two changed files and no upstream, in a 200k session,
// with Claude Code's settings and the process environment given
const world = (on: On, settings: Record<string, unknown>, env: Record<string, string>) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, env)
  on('settings.read', () => ({ value: settings }))
  on('session.usage', () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: [] } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', (_$, e) => {
    const stdout = e.argv.includes('status') ? '## main\n M a.ts\n M b.ts\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const JAPANESE = [{ type: 'Button', text: '2 未コミット' }, { type: 'Text', text: 'GitHub未公開' }] as const
const ENGLISH = [{ type: 'Button', text: '2 uncommitted' }, { type: 'Text', text: 'not on GitHub' }] as const

describe('language option', () => {
  const cases = [
    { name: 'auto follows Claude Code replying in Japanese', options: {}, settings: { language: 'japanese' }, env: { LANG: 'en_US.UTF-8' }, shows: JAPANESE },
    { name: 'auto follows a Japanese locale when Claude Code has no language', options: {}, settings: {}, env: { LANG: 'ja_JP.UTF-8' }, shows: JAPANESE },
    { name: 'auto is English on a first install in an English locale', options: {}, settings: {}, env: { LANG: 'en_US.UTF-8' }, shows: ENGLISH },
    { name: 'auto is English with nothing to go by', options: {}, settings: {}, env: {}, shows: ENGLISH },
    { name: 'auto follows Claude Code replying in English over a Japanese locale', options: {}, settings: { language: 'English' }, env: { LANG: 'ja_JP.UTF-8' }, shows: ENGLISH },
    { name: 'en fixes English', options: { language: 'en' }, settings: { language: 'japanese' }, env: { LANG: 'ja_JP.UTF-8' }, shows: ENGLISH },
    { name: 'ja fixes Japanese', options: { language: 'ja' }, settings: {}, env: { LANG: 'en_US.UTF-8' }, shows: JAPANESE },
  ]

  for (const c of cases) {
    test(c.name, { options: c.options }, async ($, on) => {
      world(on, c.settings, c.env)
      await $.session.start(START)
      const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

      for (const query of c.shows) expect(await ui.find(query)).toBeDefined()
    })
  }
})
