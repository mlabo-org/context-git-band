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

const HREF = 'http://localhost/compact'
const WINDOW = 200_000
// What the engine reported for a 200k window: the window less 33k
const AUTO_COMPACT = 167_000

// The world beneath the plugin: a 200k session holding `tokens()` tokens
const world = (on: On, tokens: () => number) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  on('settings.read', () => ({ value: {} }))
  on('session.usage', (_$, e) => {
    const context = { tokens: tokens(), window: WINDOW, percent: Math.round((tokens() / WINDOW) * 100) }
    const breakdown = e.breakdown === undefined ? {} : { breakdown: { autoCompactThreshold: AUTO_COMPACT } }
    return { value: { startedAt: 0, context: { ...context, ...breakdown }, rateLimits: [] } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

describe('compact link', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`50k before auto-compaction the weather is a link that compacts on ${surface}`, async ($, on) => {
      let compacts = 0
      world(on, () => 120_000)
      on('session.compact', () => {
        compacts += 1
        return { skip: 'test' }
      })

      await $.session.start(START)
      const ui = await $.ui.mount({ plugin: 'context-git-band', surface, component: 'AbovePrompt', props: PROPS })
      const link = await ui.find({ type: 'Markdown', key: 'compact' })
      expect(String(link?.props.text)).toContain('Showers 60% (120k/200k)')

      await ui.press({ key: 'compact', link: { href: HREF } })
      expect(compacts).toBe(1)
    })
  }

  test('no link before that point or while a turn runs', async ($, on) => {
    // 116k: just under 167k less 50k
    let tokens = 116_000
    world(on, () => tokens)

    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Markdown', key: 'compact' })).toBeUndefined()

    tokens = 117_000
    await ui.redraw({ ...PROPS, isWorking: true })
    expect(await ui.find({ type: 'Markdown', key: 'compact' })).toBeUndefined()

    await ui.redraw(PROPS)
    expect(await ui.find({ type: 'Markdown', key: 'compact' })).toBeDefined()
  })
})
