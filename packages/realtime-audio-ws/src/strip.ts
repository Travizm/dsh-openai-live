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
 * through. Two of the six row kinds carry UI: `html` for raw markup, `script` for an inline classic script.
 * So the markup is here and the bootstrap is here, and **the panel's logic is not**: everything that
 * decides what to render and what a button does lives in the client bundle
 * (`src/client/index.ts`), where it is covered by tests. A panel implemented inside an injected string is a
 * feature nothing can execute in CI, which is the same defect class as a build artefact no test reads.
 *
 * The bootstrap is therefore three statements, and it is still *executed* by a test — as a function with a
 * fake scope — so the injected code is not exempt from the gate just because it is shipped as text.
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

/**
 * The panel's container, as markup.
 *
 * Fixed to the bottom right, inheriting the host's font and colour rather than inventing a second visual
 * language beside it — but **opaque**, and that is a correction rather than a taste. This panel sits over
 * the host's own text, so a translucent wash lets the page show through and the two become unreadable
 * together: two texts superimposed, neither of them legible. That was reported from a screenshot of the
 * running app, which is the only way it was ever going to be found — nothing in a DOM test can see what is
 * *behind* the panel.
 *
 * `Canvas` is the theme's own surface colour, so the panel follows light or dark mode without naming a
 * palette of its own, and the 6% tint of the inherited colour keeps the surface from reading as a hole
 * punched in the page. The soft shadow says it sits above the page — not a border, which would be visual
 * noise around a strip whose job is to be glanced at.
 * @returns one `html` row's payload.
 */
export function stripMarkup(): string {
  return [
    `<div id="${STRIP_ELEMENT_ID}"`,
    ' style="position:fixed;right:12px;bottom:12px;z-index:40;',
    'max-width:26rem;max-height:60vh;overflow:auto;padding:10px 12px;',
    'font:inherit;color:inherit;line-height:1.4;',
    'background:color-mix(in srgb, Canvas 94%, currentColor);',
    'box-shadow:0 4px 16px rgb(0 0 0 / 0.18);border-radius:10px">',
    '</div>',
  ].join('')
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
 * The two rows this plugin contributes for its panel.
 *
 * `body` placement for both: the strip belongs to the page's chrome rather than to its head, and a `body`
 * row is rendered after the module queue's own `head` rows, which is the ordering the bundle's bootstrap
 * expects.
 *
 * Neither payload may contain a closing script or style tag — the table's own contract, because the row is
 * spliced into the document text — and a test asserts that for both, alongside executing the bootstrap.
 * @returns the rows, in the order they must execute.
 */
export function stripRows(): InjectedRow[] {
  return [
    { kind: 'html', placement: 'body', html: stripMarkup() },
    { kind: 'script', placement: 'body', text: stripBootstrap() },
  ]
}
