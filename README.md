# usage-mod

A Claude Code mod that shows where your tokens went and how close you are to your plan's limits.

- **Above the prompt:** one line with your 5-hour and weekly limit bars, the time left until each resets, and this week's split by model. The bars turn yellow at 80% and red at 95%.
- **Warnings:** a toast at 80% and again at 95% of each limit window, once per window.
- **Details panel:** the **Details** button or `/usage-breakdown` opens a side panel with this week's tokens by model and by session (title, project, tokens, share, last 5 hours, main model).

It counts every Claude Code session on your machine (desktop app and terminal) since your weekly window began, or the last 7 days when there is no limit reading yet. Subagent work counts toward the session that started it. It refreshes every minute.

"Tokens" means input + cache writes + output. Cache reads (re-used context) are listed separately.

## Install

At the prompt of a terminal session:

```
/plugin install usage-mod --marketplace Jekoff/claude-usage-mod
```

From a shell:

```bash
claude plugin install usage-mod --marketplace Jekoff/claude-usage-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Jekoff/claude-usage-mod`, then Add plugin.

## Requirements

- A Claude Code build that runs mods (function-hook plugins).
- macOS or Linux with `/usr/bin/python3`: a small script totals the session logs in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). Nothing leaves your machine.
- Limit bars need a Claude subscription (Pro or Max); on an API key only the token breakdown shows.

The limit percentages come from the latest reply in the session you are looking at, so a session that has been idle shows its last reading.
