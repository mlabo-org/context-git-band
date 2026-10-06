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
const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const FRENCH = {
  week: 'sem',
  quotaAlt: '{label} {remaining}% restant',
  uncommitted: '{count} non validés',
  commitPrompt: 'Valide les modifications non validées',
  clean: '✔ propre',
  noUpstream: 'sans upstream',
  notOnGitHub: 'pas sur GitHub',
  unpushed: '↑{count} non poussés',
  compactSoon: 'Contexte {used}/{window} : compact bientôt',
  compactSkipped: 'compact ignoré : {reason}',
  compactFailed: 'compact impossible pour le moment',
}

// A repo with two changed files and no upstream; Claude Code replies in `language`,
// and the model answers a translation with `reply`
const world = (on: On, language: string, reply: string) => {
  const calls: string[] = []
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/Users/me' })
  on('settings.read', () => ({ value: { language } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: [] } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', (_$, e) => {
    const stdout = e.argv.includes('status') ? '## main\n M a.ts\n M b.ts\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('model.complete', (_$, e) => {
    calls.push(e.prompt)
    return { value: { isAnswered: true, text: reply, usage: USAGE } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return calls
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

describe('translated words', () => {
  test('another language is translated once and shown', async ($, on) => {
    const calls = world(on, 'french', `Voici :\n${JSON.stringify(FRENCH)}`)
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    await ui.redraw()

    expect(await ui.find({ type: 'Button', text: '2 non validés' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'pas sur GitHub' })).toBeDefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('"french"')

    // Settled again (the 3 s tick, a new session start): no second call
    await $.session.start(START)
    expect(calls).toHaveLength(1)
  })

  test('a translation that drops a placeholder is thrown away', async ($, on) => {
    const broken = { ...FRENCH, uncommitted: 'non validés' }
    const calls = world(on, 'french', JSON.stringify(broken))
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    await ui.redraw()

    expect(calls).toHaveLength(1)
    expect(await ui.find({ type: 'Button', text: '2 uncommitted' })).toBeDefined()
  })

  test('a reply that is not JSON leaves English', async ($, on) => {
    world(on, 'french', 'Désolé, je ne peux pas.')
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    await ui.redraw()

    expect(await ui.find({ type: 'Button', text: '2 uncommitted' })).toBeDefined()
  })

  for (const language of ['japanese', 'English']) {
    test(`${language} is written, never translated`, async ($, on) => {
      const calls = world(on, language, JSON.stringify(FRENCH))
      await $.session.start(START)
      await $.ui.mount({ plugin: 'context-git-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

      expect(calls).toHaveLength(0)
    })
  }
})
