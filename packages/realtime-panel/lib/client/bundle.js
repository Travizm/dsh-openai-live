/**
 * Client face — the always-on half of the faceplate.
 *
 * One job: the lamp and the microphone switch must be visible without opening anything, in chrome that
 * cannot be collapsed and that exists on both the desktop app and the web client. That rules out every
 * session-scoped seat (they vanish on the New Session screen) and the right column (the host closes it by
 * itself on narrow windows). `sidebar.footer.action` is root-scoped, host-laid-out — so there are no
 * coordinates to maintain — and it is the very row the old bottom strip was covering.
 *
 * State comes from the audio face's published global rather than a package dependency: the transport face
 * stays ungated (declaring its services would gate its start-up, microphone included), and this face can be
 * absent without taking the microphone with it.
 *
 * Two inject lists, at two levels, and mixing them up is silent: `dsh.client.inject` in package.json is
 * **package ids** the loader must have loaded first; the module's own `inject` below is **service names**.
 */
window.__ModuleLoader__.load({
  id: 'dsh-realtime-panel',
  factory: (require) => {
    // Set BEFORE `require`, so a diagnostic reading null means "never loaded" and a reading with
    // factory:true but no `applied` means "loaded and threw". Those are different failures.
    globalThis.__realtimePanel = { factory: true, loaded: false, applied: false, error: null }
    const React = require('react')
    const h = React.createElement

    const { useState, useEffect, useRef } = React
    const GLOBAL_KEY = '__dshRealtimeAudio'

    /** What the audio face is doing, read defensively — an older audio face may publish less. */
    const readAudio = () => {
      const g = globalThis[GLOBAL_KEY]
      if (g === undefined || typeof g.state !== 'function') return { kind: 'absent' }
      try {
        const s = g.state() || {}
        return { kind: s.kind ?? (s.audio && s.audio.kind) ?? 'unknown' }
      } catch {
        return { kind: 'error' }
      }
    }

    const LABEL = { live: 'LIVE', connecting: 'WAIT', failed: 'FAULT', error: 'FAULT', absent: 'NOT CONNECTED', unknown: 'CLOSED' }
    const COLOUR = { live: '#33d06a', connecting: '#e8a72a', failed: '#e5484d', error: '#e5484d', absent: '#5a5f66', unknown: '#3a3d42' }

    /** The lamp, the input meter's hairline and the microphone rocker — the whole always-on surface. */
    function VoiceFooter() {
      const [audio, setAudio] = useState(readAudio)

      // A 500 ms poll, not a repaint loop: the state that matters here (connected or not) changes rarely,
      // and the meter's fast axis will write to a CSS custom property rather than to React state.
      useEffect(() => {
        const timer = setInterval(() => { setAudio(readAudio()) }, 500)
        return () => { clearInterval(timer) }
      }, [])

      const kind = audio.kind
      const live = kind === 'live'
      const colour = COLOUR[kind] ?? COLOUR.unknown

      const toggle = () => {
        const g = globalThis[GLOBAL_KEY]
        if (g === undefined) return
        if (live || kind === 'connecting') { g.stop?.() } else { g.start?.() }
      }

      return h('div', {
        'data-voice-panel': 'footer',
        style: {
          display: 'flex', alignItems: 'center', gap: '7px', padding: '0 2px', flex: '0 0 auto',
          font: '10px/1 ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '0.16em',
          color: '#efe7d2',
        },
      },
        h('span', {
          // No state WORD here, deliberately. Measured: `IDLE` → `LIVE` → `NOT CONNECTED` grew this element
          // from 117px to 165px and cut the host's neighbour from 101px to 53px of the 105px it needs. A
          // variable-length phrase cannot be made width-stable in a row this narrow, and a status element
          // that reflows when the voice connects is worse than no status element. The lamp's colour carries
          // the state; the word lives in the tooltip and, in full, on the plate in the right pane.
          style: {
            width: '9px', height: '9px', borderRadius: '50%', flex: '0 0 auto',
            background: colour, boxShadow: `0 0 6px ${colour}`, cursor: 'pointer',
          },
          onClick: () => { openPlate() },
          title: `voice unit: ${kind} — click to open the unit`,
          'aria-label': `voice unit: ${kind}; open the voice unit`,
        }),
        h('button', {
          type: 'button',
          onClick: toggle,
          'data-voice-panel-mic': '',
          'aria-pressed': live,
          title: live ? 'disconnect the microphone' : 'connect the microphone',
          style: {
            padding: '2px 8px', borderRadius: '3px', cursor: 'pointer', flex: '0 0 auto',
            // The word is constant and the switch LIGHTS instead. Measured: `MIC` vs `MIC ON` moved this
            // element 64px → 82px and shrank the host's label by 18px. A rocker that changes its legend when
            // it engages is also wrong on the hardware it imitates — the lamp and the button both light.
            border: live ? '1px solid #33d06a' : '1px solid #4a4d53',
            background: live ? 'linear-gradient(#2f4a37, #22352a)' : 'linear-gradient(#2c2f34, #1f2126)',
            color: live ? '#d9ffe6' : '#efe7d2',
            font: 'inherit', letterSpacing: '0.16em',
          },
        }, 'MIC'))
    }

    // ---- the plate: the right-pane half ------------------------------------------------------------------
    // A tab type registers in TWO stages, and doing only the second fails with
    // `sidebarRight: no tab type is registered as "<kind>"`:
    //   1. its definition into `ctx.sidebarRightTabs` — {id, kind, title}
    //   2. its body and its chip into the keyed `sidebar.right.pane.tab` and `.title` seats, under the
    //      definition's **id**
    // and `ctx.sidebarRight.openTab(<kind>)` opens by the definition's **kind**, not its id.
    const TAB_ID = 'dsh-realtime-panel/voice'
    const TAB_KIND = 'realtimeVoice'

    /** Set by `apply`; the footer's lamp uses it so the always-on element is also the way in. */
    let openPlate = () => {}

    /** The pane's tab body: the audio face's OWN mount, hosted here rather than reimplemented. */
    function VoicePlate() {
      const hostRef = useRef(null)

      useEffect(() => {
        const host = hostRef.current
        if (host === null) return undefined
        const el = document.createElement('div')
        el.setAttribute('data-voice-plate-host', '')
        host.appendChild(el)

        try {
          const face = require('dsh-realtime-audio-ws')      // the tested renderer, not a copy of it
          const g = globalThis[GLOBAL_KEY]
          const D = globalThis.__realtimePanel || (globalThis.__realtimePanel = {})
          if (g === undefined || typeof face.mountStrip !== 'function') {
            el.textContent = 'the audio face is not loaded'
            D.mountError = 'no audio face / mountStrip'
          } else {
            // The same deps the docked strip is given, sourced from the published global.
            const strip = face.mountStrip({
              root: el,
              request: (frame) => g.request(frame),
              connect: () => g.start(),
              disconnect: () => { g.stop() },
              audio: () => g.state(),
            })
            strip?.refresh?.()
            D.mounted = true
          }
        } catch (e) {
          const D = globalThis.__realtimePanel || (globalThis.__realtimePanel = {})
          D.mountError = String((e && e.message) || e)
          el.textContent = 'mount failed: ' + D.mountError
        }

        // Only the DOM is removed here. No `client.stop()`: the host may dispose this seat without consent,
        // and a held microphone and a live audio graph must not die with a view.
        return () => { el.remove() }
      }, [])

      return h('div', { 'data-voice-panel': 'plate', ref: hostRef, style: { height: '100%', overflow: 'auto' } })
    }

    /** The tab's label in the pane's tab strip. */
    function VoicePlateTitle() {
      return h('span', { style: { letterSpacing: '0.1em' } }, 'VOICE')
    }

    const name = 'realtime-panel-client'
    const inject = ['slots']

    function apply(ctx) {
      const D = (globalThis.__realtimePanel = { ...(globalThis.__realtimePanel || {}), loaded: true, applied: true, injected: false, registered: false, error: null })
      try {
        if (!ctx || !ctx.slots) { D.error = 'no ctx.slots service'; return }

        // What the loader's `require` can actually resolve matters: if a sibling client face is reachable,
        // the plate can reuse the audio face's OWN tested renderer instead of duplicating it.
        const probes = {}
        for (const id of ['react', 'react-dom', 'dsh-realtime-audio-ws', 'dsh-realtime-audio-ws/client', 'dsh-openai-live']) {
          try {
            const m = require(id)
            probes[id] = Object.keys(m || {}).slice(0, 10)
          } catch (e) {
            probes[id] = 'ERR ' + String((e && e.message) || e).slice(0, 70)
          }
        }
        D.requires = probes

        ctx.slots.inject('sidebar.footer.action', () => {
          D.injected = true
          try {
            const out = ctx.slots.register(
              { name: 'sidebar.footer.action', id: 'realtime-panel', order: 100, inject: () => ({}) },
              VoiceFooter,
            )
            D.registered = true
            return out
          } catch (e) {
            D.error = 'register: ' + String((e && e.message) || e)
            return undefined
          }
        })

        // Retire the docked presentation. The plate now lives in the pane, so the strip's reserved band and
        // its fixed bottom bar must go: the pane scrolls, not the page, and nothing may overlay the sidebar.
        // The element is hidden *and* removed — the audio face's client tolerates a missing root
        // (`if (root === null) return`), so the docked strip simply never mounts where there is no root.
        try {
          const style = document.createElement('style')
          style.setAttribute('data-voice-panel-style', '')
          style.textContent = [
            // The docked strip's own band and bar.
            'body { padding-bottom: 0 !important; }',
            '#dsh-realtime-strip { display: none !important; }',
            // The plate's container. The strip styles its container by id (`#dsh-realtime-strip`), so the
            // plate cannot inherit that rule without taking an id that collides with the element being
            // retired — and the hide rule above would then hide the plate. These are the container's own
            // declarations, restated for the host element and no longer docked.
            '[data-voice-plate-host] {',
            '  display: flex; flex-direction: column; box-sizing: border-box;',
            '  font-family: ui-monospace, "SF Mono", Menlo, monospace;',
            '  font-size: 11px; line-height: 1.35; color: #e9e2ce;',
            '  background: repeating-linear-gradient(90deg, rgb(255 255 255 / 1.5%) 0 1px, rgb(20 22 25 / 0%) 1px 3px),',
            '              linear-gradient(180deg, #26282c 0%, #1b1d20 42%, #141619 100%);',
            '  border: 1px solid #3a3d42; border-radius: 4px; margin: 8px;',
            '  -webkit-user-select: none; user-select: none;',
            '}',
            '[data-voice-plate-host] * { box-sizing: border-box; }',
            // The row was built for the docked strip's FULL width: one non-wrapping flex line of
            // fixed-width controls. A pane is narrower, and below roughly 700px the last control runs
            // past the plate's border — measured at 1200/1000/900px viewports as 82, 58 and 158px past
            // the right edge, with MIC escaping too at 900. Wrapping keeps every control legible;
            // nothing is hidden, ellipsised or shrunk to fit.
            '[data-voice-plate-host] .dvr-row {',
            '  flex-wrap: wrap; height: auto; min-height: 58px;',
            '  padding: 6px 14px; row-gap: 8px;',
            '}',
            '[data-voice-plate-host] .dvr-row > * { flex-shrink: 0; }',
            // The pane scrolls; the plate does not need its own ceiling.
            '[data-voice-panel="plate"] .dvr-panel { max-height: none !important; }',
          ].join('\n')
          document.head.appendChild(style)
          document.getElementById('dsh-realtime-strip')?.remove()
          D.dockedRetired = true
        } catch (e) {
          D.dockedError = String((e && e.message) || e)
        }

        // The plate's whole life sits inside `ctx.inject`, which WAITS for the services and hands back a
        // scoped context. `ctx.get` is a race at apply time — one boot resolved `sidebarRight`, the next did
        // not — and reading an undeclared service off `ctx` throws outright. This is the host's own pattern:
        // `ctx.inject(["sidebarRightTabs"], (scope) => { const tabs = scope.sidebarRightTabs; ... })`.
        if (typeof ctx.inject !== 'function') {
          D.tabTypeError = 'no ctx.inject'
        } else {
          ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
            try {
              const tabs = scope.sidebarRightTabs
              const sr = scope.sidebarRight

              // Stage 1: the tab type's definition. Without it the opener throws "no tab type is registered".
              if (tabs !== undefined && typeof tabs.register === 'function') {
                const dispose = tabs.register({ id: TAB_ID, kind: TAB_KIND, title: () => 'VOICE' })
                D.tabTypeRegistered = true
                scope.effect(() => () => { try { dispose?.() } catch { /* disposed twice is fine */ } }, 'realtime-panel: voice tab type')
              } else {
                D.tabTypeError = 'sidebarRightTabs has no register()'
              }

              // Stage 2: the body and the chip, under the definition's id.
              scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
                { name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({}) },
                VoicePlate,
              ))
              scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register(
                { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
                VoicePlateTitle,
              ))
              D.tabRegistered = true

              // Opening: by the definition's KIND, not its id.
              openPlate = () => {
                try {
                  if (sr === undefined || typeof sr.openTab !== 'function') { D.lastOpen = 'no sidebarRight.openTab'; return }
                  sr.openTab(TAB_KIND)
                  D.lastOpen = 'openTab called'
                } catch (e) {
                  D.lastOpen = 'ERR ' + String((e && e.message) || e)
                }
              }
              D.openPlateReady = true
              D.open = () => { openPlate() }
            } catch (e) {
              D.tabError = String((e && e.message) || e)
            }
          })
        }

        // Opening is set inside `ctx.inject` above, where the services are known to exist.
        if (D.open === undefined) D.open = () => { openPlate() }
      } catch (e) {
        D.error = 'apply: ' + String((e && e.message) || e)
      }
    }

    return { name, inject, apply }
  },
})
