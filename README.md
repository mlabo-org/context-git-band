# context-git-band

[日本語](README.ja.md)

A Claude Code mod (needs Claude Code 2.1.287 or later). It draws one line above the prompt, in the terminal and in the desktop Code tab:

![The band in the desktop Code tab, in English](docs/band-en.png)

In the terminal, with `language` set to `en`:

```
☂ Showers 54% (108k/200k) │ 5h ████████▊░ 88% wk ███████▋░░ 77% │ main ● [5 uncommitted] · ↑2 unpushed  [Hide]
```

Claude Code only; Codex has no mods.

## What it shows

### Context window as weather

- The fill of the context window, as a share of the model's whole window: ☀ Clear (under 25%), ☁ Cloudy, ☂ Showers (50%), ☇ Storm (75%), ↯ Compact Soon (90%), with the tokens used.

### Compact link

- 50k tokens before Claude Code's own auto-compaction, between turns, the weather part is drawn as a link (`☂ Showers 60% (120k/200k) ⟲ compact`), and a toast says so once.
- Pressing the link compacts the conversation, the same call `/compact` makes; the band shows `⟳ Compacting…` until it ends.
- The auto-compaction point is read from the engine each turn (`autoCompactThreshold` of the `/context` breakdown, estimated locally, no request). Measured, it is the window less 33k, so the link comes at 117k of 200k (58.5%) and 917k of 1M. With auto-compaction off, the window itself is the limit.
- While a turn runs, the part stays plain text, since a compaction is refused then.

### Subscription quota

- What is left of the 5-hour and weekly windows, as remaining percent, each with a 10-cell gauge: green, yellow at 25% or less, red at 10% or less. The terminal draws the gauge in block characters (eighths of a cell); the desktop Code tab draws it as a rounded SVG bar.
- Two sources, the newer reading shown:
  - this session's own API responses (`session.measure`'s `rateLimits`), shown the moment a window moves a whole point;
  - the account usage endpoint `https://api.anthropic.com/api/oauth/usage`, so use from other sessions shows too. It is fetched through `$.http.fetch` with the session's own credential (`$.session.authorize()`; the token never reaches the mod): at session start, when a turn ends (at most once a minute) and otherwise every 3 minutes. A failure or a 429 doubles the wait, up to 15 minutes.
- The result, the last fetch time and the backoff are kept in the plugin's `$.store`, which every session reads, so open sessions share one fetch.
- The endpoint is undocumented and may change or stop working.
- Nothing shows until one of the sources has a reading, nor off a subscription (an API key).

### Git state

- The session folder's branch, uncommitted files, unpushed commits (↑) and commits behind (↓).
- A branch with no upstream shows `GitHub未公開`, or `upstreamなし` when the repo's remotes are all off GitHub.
- It is read at session start, on each prompt, after Bash/Edit/Write tool calls (at most once every 2 s) and when a turn ends.
- In a folder that is not a Git repository, or on a host that cannot run commands (`$.process` is CLI only), the line shows the context part alone.
- When there are uncommitted files, the count is a button: pressing it submits `未コミットの変更をコミットして` as your prompt, so the session starts the commit (queued until the current turn ends).

### Hide

- `Hide` collapses the line to a small `▸ ctx/git` button; press it to bring the line back.
- The band stacks with the bands of other mods beneath it.

## Language

The band's own words (`5h`/`wk`, `uncommitted`, `clean`, `not on GitHub`, `unpushed`, and the prompt the uncommitted button sends) are in Japanese or English. The weather names are English in both.

The plugin's `language` option picks them, `auto` by default:

- `auto` follows Claude Code's own `language` setting (the language Claude replies in): Japanese when it is Japanese, English when it is anything else. With no such setting, it follows the locale (`LC_ALL`, `LC_MESSAGES`, `LANG`): Japanese when it starts with `ja`, English otherwise. A first install with neither shows English.
- `ja` or `en` fixes the language.

Change it in the `/config` panel, where the option is a picker of `auto`, `ja` and `en`; the value is saved under `pluginConfigs` in `~/.claude/settings.json`. The language is settled when a session starts.

## Install

The source of truth is this directory. Install it through the `suzuki-local-plugins` marketplace:

```bash
~/.claude/local-plugins/bin/claude-plugin-refresh context-git-band --execute
```

Then restart the Claude app or open a new session.

## Check

```bash
claude plugin validate ~/plugins/context-git-band
```

```bash
claude plugin test ~/plugins/context-git-band
```

## Credits

The weather metaphor and its five levels come from the Token Weather example in [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/) on the Anthropic blog. The code here is written independently and does not include that example's code.

## License

[MIT](LICENSE)
