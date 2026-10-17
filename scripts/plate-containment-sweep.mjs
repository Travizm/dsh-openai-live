#!/usr/bin/env node
/**
 * The plate's layout sweep — TWO predicates, THREE drill levels, a list of window sizes.
 *
 * Measures the RENDERER (CDP + getBoundingClientRect over a live page), never a transcribed guess.
 *
 *   1. CONTAINMENT — every text leaf must lie inside the plate's own box. This is the `SETTINGS ⌃` spill:
 *      the row was built for the docked strip's full width and escaped once the pane narrowed (82px past
 *      the right edge at 1200, 58px at 1000, and at 900 both MIC at 42px and SETTINGS at 158px).
 *   2. OVERLAP — no two text leaves may intersect by ≥2px on BOTH axes, the predicate the text-overlap
 *      gate uses. A different predicate: two labels can be perfectly contained and still printed on top of
 *      each other. Neither implies the other, so both run here.
 *
 * Levels: `collapsed` (the default row), `controls` (`SETTINGS ⌃`), `all` (the deepest — every setting row,
 * the knobs and the list editor). Only the collapsed row has ever been reviewed by eye, and the deeper
 * levels carry more content in the same width.
 *
 * usage:
 *   CDP_PORT=9223 node scripts/plate-containment-sweep.mjs <url> [out-dir]
 *   SIZES=1600x1000,1290x860,900x760 LEVELS=collapsed,controls,all node scripts/plate-containment-sweep.mjs <url>
 *
 * Exit 0 = both predicates clean at every size and level; 2 = something escaped or overlapped; 3 = the
 * plate never mounted or a level would not open — a harness failure must never read as a pass.
 */
import WebSocket from 'ws'
import { writeFileSync, mkdirSync } from 'node:fs'

const url = process.argv[2] || process.env.DSH_URL
if (!url) { console.error('usage: node scripts/plate-containment-sweep.mjs <url> [out-dir]'); process.exit(64) }
const OUT = process.argv[3] || process.env.BBOX_OUT || '/tmp/plate-boxes'
const CDP = Number(process.env.CDP_PORT || 9223)
const SIZES = (process.env.SIZES || '1600x1000,1290x860,1200x1000,1000x1000,900x760,800x760,700x760,600x760')
  .split(',').map(s => s.split('x').map(Number))
const LEVELS = (process.env.LEVELS || 'collapsed,controls,all').split(',')
mkdirSync(OUT, { recursive: true })

const target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(t => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
let next = 1
const pending = new Map()
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id !== undefined) { pending.get(m.id)?.(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = next++
  pending.set(id, m => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result))
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value
const sleep = ms => new Promise(r => setTimeout(r, ms))

await send('Runtime.enable')
await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
await send('Page.navigate', { url })
// STATIC=1 measures a rendered fixture (scripts/faceplate-preview.mjs): the plate is already in the page,
// at a fixed level, with no panel to open. Nothing about the predicates changes — only the bed.
const STATIC = process.env.STATIC === '1'
await sleep(STATIC ? 2500 : 9000)
if (!STATIC) {
  const opened = await evaluate(`(() => { const p = globalThis.__realtimePanel; if (p && p.open) p.open(); return !!(p && p.open) })()`)
  if (!opened) { console.error('plate never mounted — harness failure, not a pass'); process.exit(3) }
  await sleep(1500)
}

/** Drive the plate to a level through the controls the plate itself provides. */
const setLevel = level => `(() => {
  const click = want => {
    const b = document.querySelector('[data-action="level"][data-level="' + want + '"]')
    if (b) { b.click(); return true }
    return false
  }
  if ('${level}' === 'collapsed') { return click('collapsed') ? 'collapsed' : 'already-collapsed' }
  if ('${level}' === 'controls') { return click('controls') ? 'controls' : 'no-controls-button' }
  click('controls')
  const tab = document.querySelector('.dvr-tab[data-level="all"]')
  if (tab) { tab.click(); return 'all' }
  return 'no-tab-all:' + [...document.querySelectorAll('.dvr-tab')].map(t => t.dataset.level).join('|')
})()`

const MEASURE = `(() => {
  const host = document.querySelector('[data-voice-plate-host]')
  if (!host) return { error: 'plate host not mounted' }
  const h = host.getBoundingClientRect()
  const box = { x0: Math.round(h.left), y0: Math.round(h.top), x1: Math.round(h.right), y1: Math.round(h.bottom) }
  const leaves = []
  for (const el of host.querySelectorAll('*')) {
    if (el.children.length) continue                      // leaves only: text, or a control that paints
    const t = (el.textContent || '').trim()
    if (!t) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    leaves.push({
      cls: el.className || el.tagName.toLowerCase(),
      text: t.slice(0, 22),
      x0: Math.round(r.left), y0: Math.round(r.top), x1: Math.round(r.right), y1: Math.round(r.bottom),
    })
  }
  const escaping = leaves
    .filter(l => l.x0 < box.x0 || l.y0 < box.y0 || l.x1 > box.x1 || l.y1 > box.y1)
    .map(l => ({ ...l,
      right: Math.max(0, l.x1 - box.x1), left: Math.max(0, box.x0 - l.x0),
      bottom: Math.max(0, l.y1 - box.y1), top: Math.max(0, box.y0 - l.y0) }))
  const overlaps = []
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
    const a = leaves[i], b = leaves[j]
    const iw = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
    const ih = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
    if (iw >= 2 && ih >= 2) overlaps.push({ a: a.text, b: b.text, iw, ih })
  }
  return { viewport: [innerWidth, innerHeight], box, boxHeight: box.y1 - box.y0, leafCount: leaves.length,
           leaves, escaping, overlaps }
})()`

let dirty = false, harnessBroken = false
const loopLevels = STATIC ? ['fixture'] : LEVELS
for (const level of loopLevels) {
  if (!STATIC) {
    const got = await evaluate(setLevel(level))
    await sleep(500)
    if (level === 'all' && String(got).startsWith('no-tab-all')) {
      console.log(`\n## level ${level}: could not open (${got})`)
      harnessBroken = true
    }
  }
  for (const [w, h] of SIZES) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(1100)
    const m = await evaluate(MEASURE)
    const tag = `${w}x${h}-${level}`
    console.log(`\n=== ${tag} ===`)
    if (m.error) { console.log('  ', m.error); harnessBroken = true; continue }
    writeFileSync(`${OUT}/plate-${tag}.json`, JSON.stringify(m, null, 1))
    console.log(`  box ${m.box.x1 - m.box.x0}x${m.boxHeight} · ${m.leafCount} leaves · escaping ${m.escaping.length} · overlaps ${m.overlaps.length}`)
    for (const e of m.escaping) {
      const bits = []
      if (e.right) bits.push(`right +${e.right}`)
      if (e.left) bits.push(`left +${e.left}`)
      if (e.bottom) bits.push(`bottom +${e.bottom}`)
      if (e.top) bits.push(`top +${e.top}`)
      console.log(`   ESCAPES "${e.text}" (${e.cls}): ${bits.join(', ')}px`)
      dirty = true
    }
    for (const o of m.overlaps) { console.log(`   OVERLAP "${o.a}" × "${o.b}": ${o.iw}×${o.ih}px`); dirty = true }
  }
}
console.log(`\ndumps in ${OUT} — one per size and level, for the gate`)
process.exit(harnessBroken ? 3 : dirty ? 2 : 0)
