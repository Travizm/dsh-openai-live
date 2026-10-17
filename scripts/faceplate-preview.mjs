#!/usr/bin/env node
/**
 * Render the faceplate from the BUILT artefacts, so the appearance can be looked at.
 *
 * `docs/gui-faceplate.md` §6 is blunt about why this exists: a screenshot is the only detector for
 * appearance, jsdom has no compositor, and no DOM assertion can see what is painted. The in-app run is the
 * real check and it needs an install and a restart, so this is the cheap pass before it — and it renders
 * the *shipped* code rather than a mockup: the stylesheet comes from the built host half's `stripStyles()`,
 * the markup from the built client face's `renderStrip()` (loaded through the harness's own lazy-CJS module
 * table contract, from `lib/client/bundle.js`), and the page behind it mimics the app's own
 * `html,body,#root{height:100%}` layout so the reservation `stripStyles()` makes is visible.
 *
 * Usage: node scripts/faceplate-preview.mjs [outDir]
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = resolve(process.argv[2] ?? join(root, '.faceplate-preview'))
mkdirSync(out, { recursive: true })

const { stripStyles, stripMarkup } = await import(join(root, 'packages/realtime-audio-ws/lib/strip.js'))
const bundle = join(root, 'packages/realtime-audio-ws/lib/client/bundle.js')
copyFileSync(bundle, join(out, 'bundle.js'))

/** One setting as `status` reports it, for the panel's fixture. */
const setting = (owner, field, kind, scope, value, describe, choices) => ({
  key: `${owner}.${field}`, owner, field, kind, scope, value, describe, choices,
})

/** The status a running profile reports: the responder's seven live fields and the agent's own. */
const status = {
  ok: true,
  verb: 'status',
  audio: { path: '/dsh-realtime/audio', clients: 1 },
  voice: { open: true, provider: 'openai-live', model: 'gpt-live-1', sessionId: 'session-ee033ab7' },
  journal: { size: 1204, oldestSeq: 1, last: { kind: 'delegation.seen' } },
  settings: [
    {
      key: 'realtime-responder.sessionId', owner: 'realtime-responder', field: 'sessionId', kind: 'string', scope: 'live',
      value: 'session-ee033ab7', describe: 'The DSH session the voice conversation steers', choices: ['session-ee033ab7'],
    },
    {
      key: 'realtime-responder.answerTimeoutMs', owner: 'realtime-responder', field: 'answerTimeoutMs', kind: 'number', scope: 'live',
      value: 45_000, describe: 'How long one turn waits for the agent before declining',
    },
    setting('realtime-responder', 'maxPromptChars', 'number', 'live', 4000, 'Character budget for the prompt handed to the agent'),
    setting('realtime-responder', 'redactSecrets', 'string-list', 'live', undefined, 'Values that must never be spoken or carried on the bus'),
    setting('realtime-responder', 'speakMilestones', 'boolean', 'live', true, 'Speak a step aloud as the agent works, rather than only carrying it silently'),
    setting('realtime-responder', 'maxSpokenMilestones', 'number', 'live', 3, 'Most steps spoken aloud in one turn'),
    setting('realtime-responder', 'milestoneIntervalMs', 'number', 'live', 4000, 'Shortest gap between two spoken steps'),
    setting('realtime-agent', 'delegationTimeoutMs', 'number', 'live', 180_000, 'How long the voice model waits for a responder'),
    setting('realtime-agent', 'transcriptQuietMs', 'number', 'live', 250, 'How long the transcript must be quiet before a delegation is answered from it'),
    setting('realtime-agent', 'autoStart', 'boolean', 'restart', false, 'Open a session as soon as the plugin mounts'),
    setting('realtime-agent', 'model', 'string', 'session', 'gpt-live-1', 'The model the session was opened with'),
  ],
}

/** The three drill levels, as the panel renders them. */
const states = {
  '1-collapsed': { reply: status, notes: {}, notice: '', audio: { kind: 'live' }, level: 'collapsed', drafts: {}, connecting: false },
  '2-controls': { reply: status, notes: {}, notice: '', audio: { kind: 'live' }, level: 'controls', drafts: {}, connecting: false },
  '3-all-settings': {
    reply: status,
    notes: { 'realtime-responder.maxPromptChars': 'applied', 'realtime-agent.delegationTimeoutMs': 'waits up to 180 s — 180000 / 45000 ms' },
    notice: '',
    audio: { kind: 'live' },
    level: 'all',
    drafts: { 'realtime-responder.redactSecrets': ['hunter2'] },
    connecting: false,
  },
  '4-fault': { reply: status, notes: {}, notice: '', audio: { kind: 'failed', reason: 'Permission denied' }, level: 'collapsed', drafts: {}, connecting: false },
}

const page = (name, state) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The faceplate — ${name}</title>
<style>${stripStyles()}</style>
<style>
  /* The host page, to judge the plate against real chrome rather than a bare canvas. Mimics the app's own
     layout rule and theme, so the band stripStyles() reserves is the band the app would give up. */
  html, body, #root { height: 100%; margin: 0; }
  body { font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #14161a; color: #d7dce3; }
  #root { display: flex; flex-direction: column; }
  .bar { flex: 0 0 auto; height: 38px; display: flex; align-items: center; gap: 10px; padding: 0 14px;
         border-bottom: 1px solid #22262b; color: #6f7885; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
  .chat { flex: 1 1 auto; overflow: hidden; padding: 18px 22px; }
  .turn { max-width: 52ch; margin-bottom: 16px; }
  .who { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #6f7885; margin-bottom: 3px; }
  .user { color: #e6eaf0; }
  .bot { color: #a8b2c0; }
  .hint { color: #6f7885; font-size: 11px; margin-top: 4px; }
  .composer { flex: 0 0 auto; margin: 0 22px 22px; padding: 10px 12px; border: 1px solid #2a2f35;
              border-radius: 8px; color: #5b636e; }
</style>
</head>
<body>
<div id="root">
  <div class="bar">DeepSeek Harness<span style="color:#2f353c">·</span>session-ee033ab7</div>
  <div class="chat">
    <div class="turn"><div class="who user">You</div><div class="user">Tell the session the release is approved.</div></div>
    <div class="turn"><div class="who bot">Voice</div><div class="bot">Passed to the session.</div></div>
    <div class="turn"><div class="who user">You</div><div class="user">What does the README say about installation?</div></div>
    <div class="turn"><div class="who bot">Voice</div><div class="bot">It's staged in two parts — engine first, then the app wiring. The first part installs the seam and the adapter; nothing listens until the second.</div></div>
    <div class="hint">↑ this is the bottom of the app's own column. The plate is docked below it, and the app gives up its band.</div>
  </div>
  <div class="composer">Message the session…</div>
</div>
${stripMarkup()}
<script>window.__ModuleLoader__ = { load: (entry) => { window.__faceplate = entry } }</script>
<script src="./bundle.js"></script>
<script>
  // Executed exactly as the harness's module table executes it: the script only REGISTERS a factory, and the
  // exports exist once the factory is called with the table's own require.
  const face = window.__faceplate.factory((name) => { throw new Error('this face imports nothing: ' + name) })
  document.getElementById('dsh-realtime-strip').innerHTML = face.renderStrip(${JSON.stringify(state)})
</script>
</body>
</html>`

for (const [name, state] of Object.entries(states)) {
  writeFileSync(join(out, `${name}.html`), page(name, state))
}

/**
 * Pane variants — the plate as the RIGHT-PANE TAB renders it, at fixed container widths.
 *
 * The pages above mount the markup into `#dsh-realtime-strip`, the docked element, at whatever width the
 * window gives: full width, always. The pane is where the row actually broke (`SETTINGS ⌃` 82px past the
 * border at a 503px plate), so the sweep needs a bed that can be narrow on purpose.
 *
 * The container rules below MIRROR the panel face's own (`[data-voice-plate-host]` …). They are duplicated
 * here because the panel is a separate client face that cannot be imported into a Node render — the LIVE
 * sweep over the running page is authoritative for them, and this bed exists for CI and for level content.
 */
const PANE_WIDTHS = (process.env.PANE_WIDTHS || '703,593,503,427,327').split(',').map(Number)
const PANE_CSS = `
[data-voice-plate-host] { display: flex; flex-direction: column; box-sizing: border-box;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; line-height: 1.35; color: #e9e2ce;
  background: linear-gradient(180deg, #26282c 0%, #1b1d20 42%, #141619 100%);
  border: 1px solid #3a3d42; border-radius: 4px; margin: 8px; }
[data-voice-plate-host] * { box-sizing: border-box; }
[data-voice-plate-host] .dvr-row { flex-wrap: wrap; height: auto; min-height: 58px; padding: 6px 14px; row-gap: 8px; }
[data-voice-plate-host] .dvr-row > * { flex-shrink: 0; }
[data-voice-plate-host] .dvr-panel { max-height: none !important; }
`

const panePage = (name, state, width) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The faceplate pane — ${name} at ${width}px</title>
<style>${stripStyles()}</style>
<style>${PANE_CSS}
  html, body { margin: 0; background: #0f1114; }
  .pane { width: ${width}px; padding: 8px 0; }
</style>
</head>
<body>
<div class="pane"><div data-voice-plate-host></div></div>
<script>window.__ModuleLoader__ = { load: (entry) => { window.__faceplate = entry } }</script>
<script src="./bundle.js"></script>
<script>
  const face = window.__faceplate.factory((n) => { throw new Error('this face imports nothing: ' + n) })
  document.querySelector('[data-voice-plate-host]').innerHTML = face.renderStrip(${JSON.stringify(state)})
</script>
</body>
</html>`

for (const [name, state] of Object.entries(states)) {
  for (const w of PANE_WIDTHS) writeFileSync(join(out, `pane-${name}-${w}.html`), panePage(name, state, w))
}
console.log(`rendered ${Object.keys(states).length} docked pages and ${Object.keys(states).length * PANE_WIDTHS.length} pane pages → ${out}`)

// The rows the host actually injects, for the record: the stylesheet is a head row with no placement field,
// which is a claim about the host's renderer that this prints rather than asserts.
writeFileSync(join(out, 'rows.json'), `${JSON.stringify([
  { kind: 'global', name: '__DSH_REALTIME_AUDIO__', value: { path: '/dsh-realtime/audio', authority: '127.0.0.1:19387', token: '…' } },
  { kind: 'style', text: `${stripStyles().length} chars` },
  { kind: 'html', placement: 'body', html: stripMarkup() },
  { kind: 'script', placement: 'body', text: '…' },
], null, 2)}\n`)

console.log(`PASS faceplate preview — ${Object.keys(states).length} states → ${out}`)
