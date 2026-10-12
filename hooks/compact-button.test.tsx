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

const WINDOW = 200_000
// What the engine reported for a 200k window: the window less 33k
const AUTO_COMPACT = 167_000

// The world beneath the plugin: a 200k session holding `tokens()` tokens
const world = (on: On, tokens: () => number) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  on('settings.read', () => ({ value: {} }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
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

describe('compact button', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`a button beside the weather compacts on ${surface}`, async ($, on) => {
      let compacts = 0
      world(on, () => 120_000)
      on('session.compact', () => {
        compacts += 1
        return { skip: 'test' }
      })

      await $.session.start(START)
      const ui = await $.ui.mount({ plugin: 'context-git-band', surface, component: 'AbovePrompt', props: PROPS })
      expect(await ui.find({ type: 'Text', text: 'Showers 60%' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()

      await ui.press({ key: 'compact' })
      expect(compacts).toBe(1)
    })
  }

  test('two quick presses compact once', async ($, on) => {
    let compacts = 0
    let finish = () => {}
    const running = new Promise<void>(resolve => {
      finish = resolve
    })
    world(on, () => 120_000)
    on('session.compact', async () => {
      compacts += 1
      await running
      return { skip: 'test' }
    })

    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    // The second press lands while the first compaction still runs
    const first = ui.press({ key: 'compact' })
    const second = ui.press({ key: 'compact' })
    finish()
    await Promise.all([first, second])
    expect(compacts).toBe(1)
  })

  test('the button is there well before auto-compaction, but not while a turn runs', async ($, on) => {
    // 10k: far under 167k less 50k, where the toast comes
    world(on, () => 10_000)

    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()

    await ui.redraw({ ...PROPS, isWorking: true })
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()

    await ui.redraw(PROPS)
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
  })
})
