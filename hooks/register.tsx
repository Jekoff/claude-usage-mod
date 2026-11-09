import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Report } from '../types'

const PANE = 'usage-mod'
const report = atom({ plugin: 'usage-mod', key: 'report' } as const, null, { shape: 'report-1' })
const limits = atom({ plugin: 'usage-mod', key: 'limits' } as const, [])

const HOUR = 3_600_000
const DAY = 24 * HOUR
const THRESHOLDS = [95, 80]
const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'Week', spend_limit: 'Spend' }
const LONG: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend' }

export const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)
const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '–')
const bar = (p: number, width: number) =>
  '█'.repeat(Math.round((Math.min(p, 100) / 100) * width)).padEnd(width, '░')
const tone = (p: number) => (p >= 95 ? 'error' : p >= 80 ? 'warning' : undefined)
const cell = (s: string) => s.replace(/[|\\`*_<>[\]]/g, '\\$&')

export function until(resetsAt: string | undefined, now: number) {
  const ms = Date.parse(resetsAt ?? '') - now
  if (!Number.isFinite(ms)) return '?'
  if (ms <= 0) return 'now'
  const m = Math.round(ms / 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`
}

/** claude-opus-5-5 → Opus 5.5, claude-sonnet-4-5-20250929 → Sonnet 4.5 */
export function modelName(id: string) {
  const parts = id.replace(/^claude-/, '').replace(/\[.*\]$/, '').split('-').filter(p => !/^\d{8}$/.test(p))
  const family = parts.find(p => /[a-z]/i.test(p))
  if (!family) return id
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${parts.filter(p => /^\d+$/.test(p)).join('.')}`.trim()
}

/** Toast once per window per threshold; $.store is shared by every session, so one session warns. */
async function warn($: EngineInterface, known: Limit[], now: number) {
  for (const l of known) {
    const level = THRESHOLDS.find(t => l.percentUsed >= t)
    if (!level || Date.parse(l.resetsAt ?? '') <= now) continue
    const key = `warned:${l.kind}`
    const prev = (await $.store.get(key)) as { resetsAt?: string; level: number } | undefined
    const sameWindow = Math.abs(Date.parse(prev?.resetsAt ?? '') - Date.parse(l.resetsAt ?? '')) < HOUR
    if (prev && sameWindow && prev.level >= level) continue
    await $.store.set(key, { resetsAt: l.resetsAt, level })
    $.ui.toast(`⚠ ${LONG[l.kind] ?? l.kind} limit at ${l.percentUsed}% — resets in ${until(l.resetsAt, now)}`)
  }
}

/** Cheap: the limit readings from this session's last API reply. */
async function checkLimits($: EngineInterface) {
  const now = await $.clock.now()
  const fresh = (await $.session.usage()).rateLimits.map(({ kind, percentUsed, resetsAt }) => ({
    kind,
    percentUsed,
    resetsAt,
  }))
  if (fresh.length) await update($, limits, () => fresh)
  await warn($, fresh, now)
  return fresh
}

/** Limits, then every session's tokens since the weekly window began (else the last 7 days). */
async function refresh($: EngineInterface) {
  try {
    const known = await checkLimits($)
    const now = await $.clock.now()
    const start = (kind: string, span: number) => {
      const at = Date.parse(known.find(l => l.kind === kind)?.resetsAt ?? '')
      return Number.isFinite(at) && at > now ? at - span : now - span
    }
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
    const run = await $.process.run([
      '/usr/bin/python3',
      `${$.plugin.root}/hooks/scan.py`,
      `${config}/projects`,
      String(start('seven_day', 7 * DAY)),
      String(start('five_hour', 5 * HOUR)),
    ])
    if (run.exitCode !== 0 || run.isStdoutTruncated) {
      $.ui.log(`usage-mod: scan failed (${run.exitCode}): ${run.stderr.slice(0, 500)}`, { to: 'debug' })
      return
    }
    const scanned: Report = { ...JSON.parse(run.stdout), scannedAt: now }
    await update($, report, () => scanned)
  } catch (err) {
    $.ui.log(`usage-mod: refresh failed: ${String(err)}`, { to: 'debug' })
  }
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Usage' })

export function paneText(r: Report | null, ls: Limit[], now: number, maxSessions: number) {
  const out: string[] = ['### Limits']
  if (ls.length === 0) {
    out.push('_No limit reading yet: it arrives with this session’s next reply (subscription plans only)._')
  } else {
    out.push('| Window | Used | Resets in |', '|---|---|---|')
    for (const l of ls) {
      const stale = Date.parse(l.resetsAt ?? '') <= now
      out.push(
        `| ${LONG[l.kind] ?? l.kind} | ${stale ? 'reset since last reading' : `${bar(l.percentUsed, 10)} ${l.percentUsed}%`} | ${stale ? '–' : until(l.resetsAt, now)} |`,
      )
    }
  }
  if (!r) return [...out, '', '_Counting this week’s sessions…_'].join('\n')

  out.push('', `### By model, this week (${fmt(r.tokens)} tokens)`)
  out.push('| Model | Tokens | Share | Last 5h | Cache reads |', '|---|--:|--:|--:|--:|')
  for (const m of r.models) {
    out.push(`| ${modelName(m.model)} | ${fmt(m.tokens)} | ${share(m.tokens, r.tokens)} | ${fmt(m.fiveTokens)} | ${fmt(m.cacheRead)} |`)
  }

  out.push('', `### By session, this week (${r.sessions.length})`)
  out.push('| Session | Project | Tokens | Share | Last 5h | Model |', '|---|---|--:|--:|--:|---|')
  for (const s of r.sessions.slice(0, maxSessions)) {
    const models = Object.entries(s.models).sort((a, b) => b[1] - a[1])
    const model = models[0] ? modelName(models[0][0]) + (models.length > 1 ? ` +${models.length - 1}` : '') : '–'
    out.push(
      `| ${cell(s.title)} | ${cell(s.project)} | ${fmt(s.tokens)} | ${share(s.tokens, r.tokens)} | ${fmt(s.fiveTokens)} | ${model} |`,
    )
  }
  const rest = r.sessions.slice(maxSessions)
  if (rest.length) {
    out.push('', `_…and ${rest.length} more sessions, ${fmt(rest.reduce((n, s) => n + s.tokens, 0))} tokens._`)
  }
  const ago = Math.round((now - r.scannedAt) / 60_000)
  out.push(
    '',
    `_Tokens = input + cache writes + output. Cache reads (re-used context, a tenth of the input price on the API) are counted apart. Updated ${ago ? `${ago}m ago` : 'just now'}; refreshes every minute._`,
  )
  return out.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-breakdown',
      description: 'Open the usage panel: limits, and tokens by session and model',
    })
    $.clock.every(60_000, () => void refresh($))
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'usage-breakdown' }, async $ => {
    await openPane($)
    void refresh($)
    return { text: 'Usage panel opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await checkLimits($).catch(() => undefined)
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ls = await read($, limits)
    const r = await read($, report)
    if (e.props.hasSurvey || (ls.length === 0 && !r)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const models = (r?.models ?? []).slice(0, 2)

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {ls.map(l =>
          Date.parse(l.resetsAt ?? '') <= now ? (
            <Text dimColor>{SHORT[l.kind] ?? l.kind}: reset</Text>
          ) : (
            <Text color={tone(l.percentUsed)}>
              {SHORT[l.kind] ?? l.kind} {bar(l.percentUsed, 8)} {l.percentUsed}%
              <Text dimColor> · {until(l.resetsAt, now)}</Text>
            </Text>
          ),
        )}
        {models.length > 0 && (
          <Text dimColor>
            Week: {models.map(m => `${modelName(m.model)} ${share(m.tokens, r!.tokens)}`).join(' · ')}
          </Text>
        )}
        <Button key="details" label="Details" onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Markdown } = $.ui.resolve(e)
    const room = Math.max(5, (e.viewport?.rows ?? 40) - 22)
    const text = paneText(await read($, report), await read($, limits), await $.clock.now(), room)
    return (
      <Box flexDirection="column">
        <Markdown text={text} />
      </Box>
    )
  })
}
