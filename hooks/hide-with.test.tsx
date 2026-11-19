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

const row = (plugin: string, text: string) => ({ plugin, tree: { type: 'Text', props: {}, children: [text] } })

describe('Hide', () => {
  test('takes cache-band’s row with it and gives it back', { options: { language: 'en' } }, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    mock.env(on, { HOME: '/Users/me' })
    on('settings.read', () => ({ value: {} }))
    on('session.usage', () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: [] } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '' } }))
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const band = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    const rows = [row('context-git-band', 'ctx'), row('cache-band', 'cache 99%'), row('render-open-band', 'Open video')]
    const list = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePromptList', props: { ...PROPS, isCollapsed: false, rows } })
    expect(await list.find({ type: 'Text', text: 'cache 99%' })).toBeDefined()

    await band.press({ key: 'hide' })
    expect(await band.find({ type: 'Button', label: '▸ ctx/git' })).toBeDefined()
    expect(await list.find({ type: 'Text', text: 'cache 99%' })).toBeUndefined()
    // A row of any other mod stays
    expect(await list.find({ type: 'Text', text: 'Open video' })).toBeDefined()

    await band.press({ key: 'show' })
    expect(await list.find({ type: 'Text', text: 'cache 99%' })).toBeDefined()
  })
})
