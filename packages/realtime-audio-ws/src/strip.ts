/**
 * The strip: the panel this plugin puts in the host's own page.
 *
 * S2 story 3. Until it existed the plugin was driven from a `globalThis` key in a devtools console, and the
 * roadmap's judgement on that was blunt — *a plugin driven from a console global will not be installed by
 * anyone*. What changes is not decoration: the on-switch moves into the page, and `sessionId`, which cost
 * two restarts and a false lead to change, becomes a picker.
 *
 * ## Where the behaviour lives, and why not here
 *
 * This module mints **rows** for `webserver/index-inject` — the door the page already receives its settings
 * through. Three of the host's six row kinds carry UI: `style` for the plate's stylesheet, `html` for raw
 * markup, `script` for an inline classic script. So the stylesheet, the markup and the bootstrap are here,
 * and **the panel's logic is not**: everything that decides what to render and what a button does lives in
 * the client bundle (`src/client/index.ts`), where it is covered by tests. A panel implemented inside an
 * injected string is a feature nothing can execute in CI, which is the same defect class as a build
 * artefact no test reads.
 *
 * The bootstrap is therefore three statements, and it is still *executed* by a test — as a function with a
 * fake scope — so the injected code is not exempt from the gate just because it is shipped as text.
 *
 * The one thing that crosses the boundary the other way is the **class names**: this file writes the
 * stylesheet and the client writes the markup that wears it, so the two can disagree without either being
 * wrong. A test reads both and refuses to let the client emit a class this stylesheet does not define.
 *
 * ## Docked, not floating
 *
 * The first version floated a rounded panel over the bottom right — the right ~40% × lower ~60% of the
 * window, on top of live chat text. That is what `docs/gui-faceplate.md` supersedes: a fixed overlay in a
 * page this plugin does not control will always overlap *something*, so the overlap is made the page's own
 * bottom band instead of the conversation. Two rules do it — the strip is a full-width 1U plate pinned to
 * the bottom, and the page's own body reserves that band with `padding-bottom`, so the app's layout sits
 * above it rather than under it. (`html body` rather than `body`: the host sets `html,body,#root{height:100%}`
 * and the app is `height:100%` inside it, so the extra specificity is what keeps the reservation winning
 * over the host's own `body` rule while the `box-sizing` keeps it inside 100% rather than making the page
 * scroll.)
 *
 * ## Two ways in, deliberately
 *
 * The bundle mounts the panel when it applies, and the injected script mounts it again in case it lands
 * first. Both are idempotent, because the order between the module table and the body rows is not something
 * this package controls, and a panel that appears only when two independent orderings agree is a panel that
 * appears only on the author's machine.
 *
 * @module dsh-realtime-audio-ws/strip
 */

import type { InjectedRow } from './injection.ts'

/** The element the panel mounts on. Duplicated in the client half, which cannot import it. */
export const STRIP_ELEMENT_ID = 'dsh-realtime-strip'

/** The height of the collapsed 1U plate, in pixels. The page reserves exactly this. */
export const STRIP_HEIGHT_PX = 58

/**
 * The panel's container, as markup.
 *
 * Nothing but an empty element with an id: the plate's appearance is the stylesheet below, and its contents
 * are minted by the client bundle. Carrying either here would put the panel's design inside a string that
 * nothing executes.
 * @returns one `html` row's payload.
 */
export function stripMarkup(): string {
  return `<div id="${STRIP_ELEMENT_ID}"></div>`
}

/**
 * The plate's stylesheet.
 *
 * Authored rather than inherited, which **reverses a documented decision**: this module used to say the
 * panel inherits the host's font and colour *"rather than inventing a second visual language beside it."*
 * A faceplate **is** a second visual language, and that is the point of it — a piece of studio hardware
 * looks the same in light and dark mode, so an authored surface stops chasing a host theme it cannot see.
 * The reversal is recorded here so it cannot later be read as an accident, and the *rationale* for the
 * original decision is kept where it still applies: the base layer is **opaque**, so the opacity that was
 * once a caveat is now a property of the material.
 *
 * Three constraints are load-bearing rather than stylistic:
 *
 * - **No `<` anywhere** — the row is spliced into the document's text, and a `<` would open an element.
 * - **No closing `style` tag**, for the same reason.
 * - **The last `background` layer is opaque.** A translucent wash lets the host page's own text read
 *   straight through the panel: two texts superimposed, neither legible. That was reported from a
 *   screenshot of the running app, which is the only way it was ever going to be found — no DOM assertion
 *   can see what is *behind* an element. The brushed top layer is deliberately translucent; the plate
 *   beneath it is not, and a test reads the last layer specifically.
 * @returns one `style` row's payload.
 */
export function stripStyles(): string {
  return `
/* The plate. Opaque last layer: see the module note. */
#dsh-realtime-strip {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2147483000;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  line-height: 1.35;
  color: #e9e2ce;
  background:
    repeating-linear-gradient(90deg, rgb(255 255 255 / 1.5%) 0 1px, rgb(20 22 25 / 0%) 1px 3px),
    linear-gradient(180deg, #26282c 0%, #1b1d20 42%, #141619 100%);
  border-top: 1px solid #3a3d42;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), 0 -8px 24px rgb(0 0 0 / 45%);
  -webkit-user-select: none;
  user-select: none;
}

/* The band the app's own layout gives up so the plate never covers the conversation.
   The reservation is the collapsed plate's height and nothing more, because a permanent band twice this
   tall would cost the conversation the screen space the whole design exists to give back. Two things may
   grow past it — a notice line, and the drill-through while it is open — both of them transient and both
   user-visible rather than silent. */
html body {
  box-sizing: border-box;
  padding-bottom: ${String(STRIP_HEIGHT_PX)}px;
}

#dsh-realtime-strip * { box-sizing: border-box; }

.dvr-row {
  display: flex;
  align-items: center;
  gap: 14px;
  height: ${String(STRIP_HEIGHT_PX)}px;
  padding: 0 14px;
}

.dvr-screw {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #6b6f76, #2a2d31 70%);
  box-shadow: inset 0 1px 1px rgb(255 255 255 / 25%), 0 1px 1px rgb(0 0 0 / 60%);
}

.dvr-brand { display: flex; flex-direction: column; line-height: 1.15; }
.dvr-name {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .34em;
  color: #efe7d2;
  text-shadow: 0 1px 0 #000, 0 -1px 0 rgb(255 255 255 / 9%);
}
.dvr-model { font-size: 8.5px; font-style: normal; letter-spacing: .2em; color: #9a8f75; margin-top: 2px; }

.dvr-rule {
  flex: 0 0 auto;
  width: 1px;
  height: 30px;
  opacity: .55;
  background: linear-gradient(180deg, rgb(201 162 39 / 0%), #c9a227 20%, #c9a227 80%, rgb(201 162 39 / 0%));
}

.dvr-jewel { display: flex; align-items: center; gap: 8px; }
.dvr-lamp {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #6a6f76, #33383d 60%);
  box-shadow: inset 0 0 3px rgb(0 0 0 / 80%);
}
.dvr-jewel[data-lamp="live"] .dvr-lamp {
  background: radial-gradient(circle at 38% 32%, #d8ffe2, #33d06a 45%, #106b34 100%);
  box-shadow: 0 0 10px rgb(51 208 106 / 65%), inset 0 0 3px rgb(255 255 255 / 70%);
}
.dvr-jewel[data-lamp="connecting"] .dvr-lamp {
  background: radial-gradient(circle at 38% 32%, #ffeec4, #e8a72a 45%, #7a5407 100%);
  box-shadow: 0 0 10px rgb(232 167 42 / 60%), inset 0 0 3px rgb(255 255 255 / 70%);
}
.dvr-jewel-label { font-size: 8.5px; font-style: normal; letter-spacing: .16em; color: #9a8f75; }

.dvr-meter { flex: 1 1 120px; max-width: 220px; }
.dvr-scale {
  display: flex;
  height: 8px;
  gap: 1px;
  padding: 1px;
  border-radius: 2px;
  background: #0d0f11;
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 90%), inset 0 -1px 0 rgb(255 255 255 / 4%);
}
.dvr-seg { flex: 1; border-radius: 1px; background: #23262a; }
.dvr-seg.on { background: linear-gradient(180deg, #7de29b, #2f9c56); }
.dvr-seg.on.warm { background: linear-gradient(180deg, #ffd98a, #d99b18); }
.dvr-seg.on.hot { background: linear-gradient(180deg, #ff9b8a, #cf3a26); }
.dvr-cap {
  display: flex;
  justify-content: space-between;
  font-size: 8px;
  letter-spacing: .14em;
  color: #8a8270;
  margin-bottom: 3px;
}

.dvr-where {
  font-size: 9px;
  letter-spacing: .14em;
  color: #9a8f75;
  padding: 2px 7px;
  border-radius: 3px;
  white-space: nowrap;
  background: linear-gradient(180deg, #101214, #17191c);
  box-shadow: inset 0 1px 0 rgb(0 0 0 / 90%), 0 1px 0 rgb(255 255 255 / 5%);
}

.dvr-spacer { flex: 1 1 auto; }

.dvr-btn {
  flex: 0 0 auto;
  cursor: pointer;
  font-family: inherit;
  font-size: 10px;
  letter-spacing: .18em;
  color: #efe7d2;
  background: linear-gradient(180deg, #33373c, #212427);
  border: 1px solid #45484e;
  border-radius: 4px;
  padding: 7px 11px;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 10%), 0 1px 2px rgb(0 0 0 / 50%);
}
.dvr-btn.on {
  color: #f4ffe8;
  border-color: #3f7f52;
  background: linear-gradient(180deg, #2f5f3d, #1c4026);
}
.dvr-btn:active { background: linear-gradient(180deg, #212427, #33373c); }

.dvr-fault, .dvr-notice {
  margin: 0;
  padding: 5px 14px 6px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 11px;
  border-top: 1px solid #2c2f34;
}
.dvr-fault { color: #ff9b8a; }
.dvr-notice { color: #efe7d2; }
.dvr-notice a { color: #e8a72a; }

/* One level of drill-through: the panel grows upward from the plate. */
.dvr-panel {
  max-height: 46vh;
  overflow: auto;
  padding: 12px 14px 14px;
  border-top: 1px solid #2c2f34;
}
.dvr-knobs { display: flex; gap: 30px; align-items: flex-start; }
.dvr-knob-unit { text-align: center; min-width: 96px; }
.dvr-knob {
  /* Block, not inline: a span's width and height are ignored, so the dial would paint as a line box and
     only its pointer would be visible. */
  display: block;
  position: relative;
  width: 46px;
  height: 46px;
  margin: 0 auto 7px;
  border-radius: 50%;
  background:
    conic-gradient(from 0deg, #2b2e33, #3a3e44 12%, #2b2e33 25%, #3a3e44 37%, #2b2e33 50%,
      #3a3e44 62%, #2b2e33 75%, #3a3e44 87%, #2b2e33),
    radial-gradient(circle at 40% 34%, #43474d, #1c1f22 72%);
  box-shadow: 0 3px 7px rgb(0 0 0 / 65%), inset 0 1px 1px rgb(255 255 255 / 14%);
}
.dvr-knob::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 4px;
  width: 2px;
  height: 15px;
  margin-left: -1px;
  border-radius: 1px;
  background: linear-gradient(180deg, #f2e9d2, #b9ad8c);
  box-shadow: 0 0 3px rgb(0 0 0 / 80%);
  transform-origin: 50% 19px;
}
.dvr-knob--0::after { transform: rotate(-135deg); }
.dvr-knob--1::after { transform: rotate(-108deg); }
.dvr-knob--2::after { transform: rotate(-81deg); }
.dvr-knob--3::after { transform: rotate(-54deg); }
.dvr-knob--4::after { transform: rotate(-27deg); }
.dvr-knob--5::after { transform: rotate(0deg); }
.dvr-knob--6::after { transform: rotate(27deg); }
.dvr-knob--7::after { transform: rotate(54deg); }
.dvr-knob--8::after { transform: rotate(81deg); }
.dvr-knob--9::after { transform: rotate(108deg); }
.dvr-knob--10::after { transform: rotate(135deg); }
.dvr-knob-label { display: block; font-size: 8.5px; letter-spacing: .15em; color: #9a8f75; }
.dvr-knob-value { display: block; font-size: 10px; color: #e9e2ce; margin-top: 2px; }
.dvr-knob-caption { display: block; font-size: 8.5px; color: #c9a227; margin-top: 3px; }
.dvr-knob-set { display: flex; gap: 6px; justify-content: center; margin-top: 6px; }

.dvr-switches { display: flex; gap: 22px; align-items: center; margin-top: 18px; }
.dvr-led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  background: #0f1113;
  box-shadow: inset 0 0 2px rgb(0 0 0 / 90%);
}
.dvr-led.on {
  background: radial-gradient(circle at 40% 35%, #fff6d5, #e8a72a 55%, #8a5f08 100%);
  box-shadow: 0 0 7px rgb(232 167 42 / 75%);
}
.dvr-led.on.green {
  background: radial-gradient(circle at 40% 35%, #dcffe6, #33d06a 55%, #0f6b34 100%);
  box-shadow: 0 0 7px rgb(51 208 106 / 70%);
}
.dvr-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-family: inherit;
  font-size: 8.5px;
  letter-spacing: .14em;
  color: #9a8f75;
  background: none;
  border: 0;
  padding: 0;
}
.dvr-switch-state { color: #e9e2ce; font-weight: 400; letter-spacing: .1em; }

.dvr-tabs { display: flex; gap: 8px; margin-top: 16px; border-top: 1px dashed #33363b; padding-top: 12px; }
.dvr-tab {
  cursor: pointer;
  font-family: inherit;
  font-size: 9px;
  letter-spacing: .16em;
  color: #8a8270;
  padding: 5px 9px;
  border: 0;
  border-radius: 3px;
  background: none;
}
.dvr-tab.active { color: #efe7d2; background: #1c1f22; box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%); }

.dvr-srow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  font-size: 10px;
  border-bottom: 1px solid #1e2124;
}
.dvr-skey { color: #9a8f75; letter-spacing: .1em; min-width: 210px; }
.dvr-sdesc { color: #6f7885; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.dvr-note { font-style: normal; color: #c9a227; }
.dvr-fixed { font-style: normal; color: #8a8270; }
.dvr-write-only { font-style: normal; color: #c9a227; width: 100%; }
.dvr-empty { color: #6f7885; padding: 6px 0; }

.dvr-input, .dvr-select {
  font-family: inherit;
  font-size: 10px;
  color: #e9e2ce;
  background: linear-gradient(180deg, #101214, #17191c);
  border: 1px solid #3a3d42;
  border-radius: 3px;
  padding: 4px 6px;
}
.dvr-input { min-width: 90px; }
.dvr-input--wide { min-width: 200px; }

.dvr-list { list-style: none; margin: 0; padding: 0; width: 100%; }
.dvr-entry { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.dvr-entry-value { color: #e9e2ce; }
.dvr-remove {
  cursor: pointer;
  font-family: inherit;
  font-size: 10px;
  color: #ff9b8a;
  background: none;
  border: 1px solid #4a3a38;
  border-radius: 3px;
  padding: 1px 5px;
}
`
}

/**
 * The bootstrap the page runs after the markup.
 *
 * It calls the bundle's own `mount`, and does nothing when the bundle has not been materialised yet — in
 * which case the bundle mounts the panel itself when it applies, or this is called again on
 * `DOMContentLoaded`. Nothing here decides anything about the panel; it is a doorbell.
 * @returns one `script` row's payload.
 */
export function stripBootstrap(): string {
  return [
    ';(function () {',
    "  function mount() { var G = globalThis.__dshRealtimeAudio; if (G && typeof G.mount === 'function') G.mount() }",
    '  mount()',
    "  if (typeof document !== 'undefined' && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)",
    '})()',
  ].join('\n')
}

/**
 * The three rows this plugin contributes for its panel.
 *
 * The stylesheet first, because it is a `head` row (the host fixes a `style` row's placement) and the
 * markup is a `body` row — the two land in different groups, so table order among them is what it looks
 * like and nothing depends on it. The markup precedes the bootstrap within `body`, and that ordering the
 * table does guarantee: the panel's element exists before the script that mounts on it runs.
 *
 * Neither payload may contain a closing script or style tag — the table's own contract, because the row is
 * spliced into the document text — and a test asserts that for both, alongside executing the bootstrap.
 * @returns the rows, in the order they must execute.
 */
export function stripRows(): InjectedRow[] {
  return [
    { kind: 'style', text: stripStyles() },
    { kind: 'html', placement: 'body', html: stripMarkup() },
    { kind: 'script', placement: 'body', text: stripBootstrap() },
  ]
}
