#!/usr/bin/env node
/**
 * The plate's containment sweep — where does its content escape its own border?
 *
 * Measures the RENDERER (CDP + getBoundingClientRect over a live page), never a transcribed guess, and
 * checks every text leaf against the plate's own box at several viewport widths. A single width proves
 * nothing: the row was built for the docked strip's full width and only overflows once the pane narrows.
 *
 * Why this exists, in numbers: clean at 1600 and 1400px, then `SETTINGS ⌃` 82px past the right edge at
 * 1200, 58px at 1000, and at 900 both `MIC` (42px) and `SETTINGS ⌃` (158px) escaped the border.
 *
 * It is NOT the text-overlap check. Overlap is a different predicate and this sweep would call two labels
 * stacked on each other "contained". See `plate-containment-gate.py` for the kernel proof and the limits.
 *
 * usage: node scripts/plate-containment-sweep.mjs <page-url> [out-dir]
 *        CDP_PORT=9223 WIDTHS=1600,1400,1200,1000,900 node scripts/plate-containment-sweep.mjs "$DSH_URL"
 *
 * Requires a Chromium started with --remote-debugging-port and pointed at the page (the CLI-served
 * instance or the app). Exit 0 = every leaf inside the box at every width; exit 2 = something escaped.
 */
import WebSocket from 'ws'
import { writeFileSync, mkdirSync } from 'node:fs'

const url = process.argv[2] || process.env.DSH_URL
if (!url) {
  console.error('usage: node scripts/plate-containment-sweep.mjs <page-url> [out-dir]')
  process.exit(64)
}
const OUT = process.argv[3] || process.env.BBOX_OUT || '/tmp/plate-boxes'
const CDP = Number(process.env.CDP_PORT || 9223)
const WIDTHS = (process.env.WIDTHS || '1600,1400,1200,1000,900').split(',').map(Number)
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

await send('Runtime.enable')
await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
await send('Page.navigate', { url })
await new Promise(r => setTimeout(r, 9000))
await evaluate(`(() => { const p = globalThis.__realtimePanel; if (p && p.open) p.open(); return !!p })()`)
await new Promise(r => setTimeout(r, 1500))

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
  const over = leaves.map(l => ({
    ...l,
    right: l.x1 - box.x1,
    bottom: l.y1 - box.y1,
    left: box.x0 - l.x0,
  })).filter(l => l.right > 0 || l.bottom > 0 || l.left > 0)
  return { viewport: [innerWidth, innerHeight], box, leafCount: leaves.length, leafRects: leaves, overflowing: over }
})()`

let dirty = false
for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false })
  await new Promise(r => setTimeout(r, 1200))
  const m = await evaluate(MEASURE)
  console.log(`\n=== viewport ${w} ===`)
  if (m.error) { console.log('  ', m.error); dirty = true; continue }
  writeFileSync(`${OUT}/plate-${w}.json`, JSON.stringify({ viewport: m.viewport, box: m.box, leaves: m.leafRects }, null, 1))
  console.log(`  plate box: x ${m.box.x0}→${m.box.x1} (w ${m.box.x1 - m.box.x0}) · ${m.leafCount} leaves`)
  if (!m.overflowing.length) { console.log('  no element escapes the box'); continue }
  dirty = true
  for (const o of m.overflowing) {
    const bits = []
    if (o.right > 0) bits.push(`past right by ${o.right}px`)
    if (o.left > 0) bits.push(`past left by ${o.left}px`)
    if (o.bottom > 0) bits.push(`past bottom by ${o.bottom}px`)
    console.log(`  "${o.text}" (${o.cls}): ${bits.join(', ')}`)
  }
}
console.log(`\nboxes written to ${OUT} — feed them to scripts/plate-containment-gate.py`)
process.exit(dirty ? 2 : 0)
