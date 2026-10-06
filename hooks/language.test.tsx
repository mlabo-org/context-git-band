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

// A repo on main with two changed files and no upstream, in a 200k session
const world = (on: On) => {
  mock.clock(on)
  mock.store(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: [] } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
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
const RATE_LIMITS = [
  { kind: 'five_hour', percentUsed: 5 },
  { kind: 'seven_day', percentUsed: 45 },
]

describe('language option', () => {
  test('ja by default', async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.session.measure({ context: CONTEXT, rateLimits: RATE_LIMITS, changed: ['rateLimits'] })
    const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect(await ui.find({ type: 'Text', text: '週' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: '2 未コミット' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'GitHub未公開' })).toBeDefined()
  })

  test('en when the option says so', { options: { language: 'en' } }, async ($, on) => {
    world(on)
    await $.session.start(START)
    await $.session.measure({ context: CONTEXT, rateLimits: RATE_LIMITS, changed: ['rateLimits'] })
    const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect(await ui.find({ type: 'Text', text: 'wk' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: '2 uncommitted' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'not on GitHub' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /[぀-ヿ一-鿿]/ })).toBeUndefined()
  })
})
