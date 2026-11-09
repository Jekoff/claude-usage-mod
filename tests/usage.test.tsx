import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { modelName, until } from '../hooks/register'
import type { Limit, Report } from '../types'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const LIMITS: Limit[] = [
  { kind: 'five_hour', percentUsed: 86, resetsAt: '2026-11-09T14:05:00Z' },
  { kind: 'seven_day', percentUsed: 18, resetsAt: '2026-11-12T16:00:00Z' },
]
const REPORT: Report = {
  tokens: 1_000_000,
  cacheRead: 40_000_000,
  fiveTokens: 300_000,
  scannedAt: NOW,
  models: [
    { model: 'claude-opus-5-5', tokens: 810_000, cacheRead: 35_000_000, fiveTokens: 300_000 },
    { model: 'claude-sonnet-5-5', tokens: 190_000, cacheRead: 5_000_000, fiveTokens: 0 },
  ],
  sessions: [
    {
      id: 'a',
      project: 'my-app',
      title: 'Landing page| content',
      tokens: 600_000,
      cacheRead: 1,
      fiveTokens: 300_000,
      lastMs: NOW,
      models: { 'claude-opus-5-5': 600_000 },
    },
    {
      id: 'b',
      project: 'Projects-api',
      title: 'Fix login bug',
      tokens: 400_000,
      cacheRead: 1,
      fiveTokens: 0,
      lastMs: NOW,
      models: { 'claude-sonnet-5-5': 210_000, 'claude-opus-5-5': 190_000 },
    },
  ],
}

const VIEW = { scroll: { offset: 0, bodyRows: 20 }, view: {} } as const

function seed(on: Parameters<TestBody>[1]) {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e) => ({
    value: {
      value: e.key === 'report' ? { shape: 'report-1', value: REPORT } : LIMITS,
      version: 1,
    },
  }))
}

test('model names and countdowns read plainly', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(modelName('claude-opus-4-6[1m]')).toBe('Opus 4.6')
  expect(until('2026-11-09T14:05:00Z', NOW)).toBe('2h 5m')
  expect(until('2026-11-12T16:00:00Z', NOW)).toBe('3d 4h')
  expect(until('2026-11-09T11:00:00Z', NOW)).toBe('now')
})

test('the band shows both limits and the model split, on every surface', async ($, on) => {
  seed(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-mod',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, ...VIEW },
    })
    expect((await ui.find({ type: 'Text', text: /^5h/ }))?.text).toContain('86%')
    expect((await ui.find({ type: 'Text', text: /2h 5m/ }))?.text).toContain('2h 5m')
    expect((await ui.find({ type: 'Text', text: /^Week:/ }))?.text).toBe('Week: Opus 5.5 81% · Sonnet 5.5 19%')
    expect(await ui.find({ type: 'Button', key: 'details' })).toBeTruthy()
    await ui.unmount()
  }
})

test('the panel breaks the week down by model and by session', async ($, on) => {
  seed(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-mod',
      surface,
      component: 'Pane',
      requestId: 'usage-mod',
      props: { title: 'Usage', isFocused: false, bodyColumns: 100, placement: 'dock', ...VIEW },
    })
    const text = (await ui.find({ type: 'Markdown' }))?.text ?? ''
    expect(text).toContain('| Opus 5.5 | 810k | 81% | 300k | 35.0M |')
    expect(text).toContain('| Landing page\\| content | my-app | 600k | 60% | 300k | Opus 5.5 |')
    expect(text).toContain('| Fix login bug | Projects-api | 400k | 40% | 0 | Sonnet 5.5 +1 |')
    expect(text).toContain('| 5-hour | █████████░ 86% | 2h 5m |')
    await ui.unmount()
  }
})

test('a limit past 80% warns once per window, again past 95%', async ($, on) => {
  const toasts: string[] = []
  const store = new Map<string, unknown>()
  let percent = 86
  on('clock.now', () => ({ value: NOW }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: '2026-11-09T14:05:00Z' }],
    },
  }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))

  const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  expect(toasts).toEqual(['⚠ 5-hour limit at 86% — resets in 2h 5m'])

  percent = 96
  await $.turn.complete(turn)
  expect(toasts.length).toBe(2)
  expect(toasts[1]).toContain('96%')
})
