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

// The session starts in a repo with one untracked folder; `place.inRepo`
// false stands for the folder it is moved to, which is not a repo
const world = (on: On, place: { inRepo: boolean }) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/Users/me' })
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: [] } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.CwdChanged', () => ({}))
  on('process.run', (_$, e) => {
    if (!place.inRepo) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }
    const stdout = e.argv.includes('status') ? '## main...origin/main\n?? scheduled-tasks/new/\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const START = { cwd: '/Users/me/.claude/spares/spare-1', surface: 'terminal', isInteractive: true } as const

describe('a move to another folder', () => {
  test('drops the old folder’s uncommitted count', { options: { language: 'en' } }, async ($, on) => {
    const place = { inRepo: true }
    world(on, place)
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Button', text: '1 uncommitted' })).toBeDefined()

    place.inRepo = false
    await $.classic.CwdChanged({ old_cwd: START.cwd, new_cwd: '/Users/me/Desktop/TEST-RUN' })

    expect(await ui.find({ type: 'Button', text: '1 uncommitted' })).toBeUndefined()
  })
})
