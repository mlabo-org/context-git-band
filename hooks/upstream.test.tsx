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

// A clean repo on main with no upstream, with the remotes and the
// remote-tracking branches given
const world = (on: On, remotes: string, remoteBranches: string) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/Users/me' })
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: [] } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', (_$, e) => {
    const stdout = e.argv.includes('status')
      ? '## main\n'
      : e.argv.includes('remote')
        ? remotes
        : e.argv.includes('for-each-ref')
          ? remoteBranches
          : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const GITHUB = 'origin\thttps://github.com/me/app.git (fetch)\norigin\thttps://github.com/me/app.git (push)\n'
const GITLAB = 'origin\thttps://gitlab.com/me/app.git (fetch)\norigin\thttps://gitlab.com/me/app.git (push)\n'

describe('a branch with no upstream', () => {
  const cases = [
    { name: 'is not on GitHub when no remote has the branch', remotes: GITHUB, remoteBranches: 'feature\n', shows: 'not on GitHub' },
    { name: 'is not on GitHub when the repo has no remote', remotes: '', remoteBranches: '', shows: 'not on GitHub' },
    { name: 'has no upstream when it was pushed without one', remotes: GITHUB, remoteBranches: 'HEAD\nmain\n', shows: 'no upstream' },
    { name: 'has no upstream when the remotes are all off GitHub', remotes: GITLAB, remoteBranches: '', shows: 'no upstream' },
  ]

  for (const c of cases) {
    test(c.name, { options: { language: 'en' } }, async ($, on) => {
      world(on, c.remotes, c.remoteBranches)
      await $.session.start(START)
      const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

      expect(await ui.find({ type: 'Text', text: c.shows })).toBeDefined()
    })
  }
})
