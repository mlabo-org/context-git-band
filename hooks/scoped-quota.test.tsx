import { describe, expect, mock, test } from 'claude-code/testing'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const CONTEXT = { tokens: 62_000, window: 200_000, percent: 31 }

// The usage endpoint's answer as observed 2026-11-20, trimmed: 5h 16% used,
// weekly 51% used, and Fable's own weekly limit 73% used
const USAGE = JSON.stringify({
  five_hour: { utilization: 16, resets_at: '2026-11-19T23:29:59+00:00' },
  seven_day: { utilization: 51, resets_at: '2026-11-24T21:59:59+00:00' },
  seven_day_opus: null,
  limits: [
    { kind: 'session', group: 'session', percent: 16, resets_at: '2026-11-19T23:29:59+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 51, resets_at: '2026-11-24T21:59:59+00:00', scope: null },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 73,
      resets_at: '2026-11-24T21:59:59+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
})

describe('a model’s own weekly limit', () => {
  test('is drawn by its model’s name and stays after a live reading', { options: { language: 'en' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    mock.env(on, { HOME: '/Users/me' })
    on('settings.read', () => ({ value: {} }))
    on('session.usage', () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: [] } }))
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: USAGE } }))
    on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '' } }))
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: 'Fable' })).toBeDefined()
    // 73% used: 27% left
    expect(await ui.find({ type: 'Text', text: '27%' })).toBeDefined()

    // This session's responses carry the 5-hour and weekly windows only
    await clock.advance(10_000)
    await $.session.measure({
      context: CONTEXT,
      rateLimits: [
        { kind: 'five_hour', percentUsed: 20 },
        { kind: 'seven_day', percentUsed: 52 },
      ],
      changed: ['rateLimits'],
    })
    expect(await ui.find({ type: 'Text', text: '80%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Fable' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '27%' })).toBeDefined()
  })
})
