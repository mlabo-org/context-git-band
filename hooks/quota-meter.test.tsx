import { describe, expect, mock, test } from 'claude-code/testing'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const CONTEXT = { tokens: 108_000, window: 200_000, percent: 54 }

// 5h 88% left, weekly 7% left
const RATE_LIMITS = [
  { kind: 'five_hour', percentUsed: 12 },
  { kind: 'seven_day', percentUsed: 93 },
]

describe('quota gauge', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws the remaining quota as a gauge on ${surface}`, async ($, on) => {
      mock.clock(on, { now: 1_000_000 })
      mock.store(on)
      on('session.usage', () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: [] } }))
      on('session.measure', (_$, e) => ({ changed: e.changed }))
      // The engine's own band beneath the plugins: nothing to show
      on('ui.render', ($, e) => {
        const { Box } = $.ui.resolve(e)
        return <Box />
      })

      await $.session.measure({ context: CONTEXT, rateLimits: RATE_LIMITS, changed: ['rateLimits'] })
      const ui = await $.ui.mount({ plugin: 'context-git-band', surface, component: 'AbovePrompt', props: PROPS })

      expect(await ui.find({ type: 'Text', text: '88%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '7%' })).toBeDefined()

      if (surface === 'desktop') {
        const gauges = await ui.findAll({ type: 'Svg' })
        expect(gauges).toHaveLength(2)
        expect(String(gauges[1]?.props.source)).toContain('#e5534b')
      } else {
        // 88% of 10 cells: 8 full, then 6 of 8 eighths
        expect(await ui.find({ type: 'Text', text: '████████▊' })).toBeDefined()
      }
    })
  }
})
