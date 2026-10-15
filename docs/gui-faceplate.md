# The faceplate — the panel, specified

**Status:** specified, not built. Written 2026-10-15 from a screenshot of the running app and four rulings from
the owner. Build from this rather than from the current markup.

**Supersedes:** the "remove the fixed-position overlay" item in `sprint-plan-voice-presence.md`. That fix
landed on **2026-10-09** (`f818904`, PR #57) and predates the complaint, so it is not the problem.

---

## 1. The brief, as given

> a) Its position is bottom right which gets in the way of the chat window
> b) it seems to be in a maximally expanded form with every field visible instead of some kind of minimal
> graphic surface with a drill through GUI to expand or navigate to settings
> c) its colour scheme and aesthetics is clearly shit....imagine a graphics aesthetic for say a protools
> plugin... like a retro valve boutique plugin by fender or marshall.
> d) in the future it would be nice if you could just say what you want it to do in the chat and the settings
> are adjusted.

## 2. What it actually is today — read off a screenshot, not inferred

A dark rounded panel floating over the **right-hand side**, from roughly 60% width to the right edge and from
mid-height to the bottom of the window: the right ~40% × lower ~60%, directly on top of live chat text.

Inside, top to bottom: a status line (`not connected: connect the microphone first`), four buttons
(**Connect microphone · Start voice · Stop voice · Refresh**), then eight bulleted items, each a **full
sentence** followed by a control and a **Set** button — every setting the plugin has, always visible.

**The one thing that is right:** the background is **opaque**. Nothing reads through it. That is `f818904`
working, and it must stay true.

**The styling is absent.** Default browser form controls on a dark box: plain grey inputs, plain buttons,
body-size text, no hierarchy, no grouping, no separation between items. The container got a considered
treatment on 9 Oct; the **contents never did**.

## 3. Three defects the screenshot showed that the code did not

| defect | why it matters |
|---|---|
| **Booleans and lists render as free-text boxes.** `true` sits in a text field; "values that must never be spoken" is an empty box for a list. | You must know the syntax and type it correctly, and one typo silently sets nothing. |
| **Two settings look identical.** "How long the voice model waits for a responder" and "How long one turn waits for the agent before declining" both read `180000`. | They are different layers' budgets. On screen they look like one knob described twice, and turning the wrong one does nothing. |
| **Permanently expanded.** There is no collapsed state at all. | It is the panel's whole footprint, unavoidably. |

## 4. The design

### Shape and position

- **Docked, not floating**: a full-width **1U strip** (≈58px) pinned to the bottom of the page, so the chat
  sits *above* it. Outboard gear lives in a rack under the console; it does not float over the mix.
- **Collapsed by default.** The strip shows **state**, not settings.
- If bottom-docked collides with the host's own status bar, the same strip docks to the top — one line of CSS.

**Note for whoever builds this:** a fixed overlay in a page this plugin does not control will always overlap
*something*. The docked shape makes the overlap the page's own chrome rather than the conversation, and the
**collapsed default is the real fix** — the reposition only makes the collapsed state cheap.

### Drill-through, three levels

| level | shows |
|---|---|
| **1 · collapsed** | pilot jewel, thin input meter, where the voice is pointed, **SETTINGS ⌃** |
| **2 · controls** | the few things worth a knob — wait budget, presentation switches |
| **3 · all settings** | the raw registry rows |

Developer detail (`journal 1204 · last delegation.seen`, socket counts) is **not** on the faceplate. It
belongs to `voice_journal` and `voice_diagnose`, which already expose it.

### Aesthetic — retro valve outboard, **generic**

Brushed dark plate, cream engraved legend with a letter-spaced wordmark, a brass rule, corner screws, a
**jewel pilot lamp** (green live / amber connecting / dark closed), a segmented LED meter, knurled-rosette
knobs with cream pointers, amber toggle LEDs.

The tokens are in the approved mockup (`strip-mockup.html`). Key values: plate `linear-gradient(#26282c →
#141619)` over a faint vertical brush; legend `#efe7d2` at `letter-spacing: .34em` with a 1px engraved
text-shadow; brass `#c9a227`; jewel green `#33d06a`, amber `#e8a72a`; meter segments green→amber→red.

**Its own name and model number — no Marshall or Fender trade dress.** The repo is public and headed to npm,
and their plate designs are protected. The *idiom* is fair game; the plate is not.

**This knowingly reverses a documented decision.** `strip.ts` currently inherits the host's font and colour
*"rather than inventing a second visual language beside it."* A faceplate **is** a second visual language. The
rationale for the reversal: hardware looks the same in light and dark mode, so the panel stops chasing the
host theme — and the opacity requirement stops being a caveat and becomes a property of the material.

### The controls — three rulings

1. **Booleans get a toggle**, not a text box.
2. **Lists get a real list editor** — add, remove, see each entry. Not a comma-separated string.
3. **The two timeouts get one control, three layers.** See below.

### The timeout control

Measured, so the design rests on facts rather than taste:

| layer | field | default | scope |
|---|---|---|---|
| `dsh-realtime-agent` | `delegationTimeoutMs` | `10_000` | **live** |
| `dsh-realtime-responder` | `answerTimeoutMs` | `45_000` | **live** |

**"The smaller bound decides what is heard"** — the responder's own docstring. Both are `live`, so a control
that sets both is an affordance the protocol *can* honour.

**The design — present the intent, reveal the mechanism:**

- **Primary:** one control, *"The voice waits up to …"*, which **writes both**. Equal is the sane
  configuration and `min(a, b)` is the truth.
- **Shown value:** the **binding** value. If they diverge, show `min` and name the cap —
  *"capped by the turn budget (45 s)"*.
- **One drill level down:** the two raw budgets, independently settable, so the mechanism is **reachable
  without being in the way** and the deeper view shows what the registry actually says.
- **Write both, then re-read both and report the pair.** Never display a value the registry did not confirm —
  a half-applied pair must be *visible as a pair*, not silently averaged.

**Fix the two labels while there** — they are currently indistinguishable:
agent's → **"How long the voice model waits for a reply"**; responder's → **"How long one turn waits for the
agent"**; merged → **"The voice waits up to"**, captioned *"the smaller of the two governs, so this sets both."*

**The condition that flips this:** if the agent's bound should ever *exceed* the responder's on purpose — a
slow turn spoken rather than declined — two controls are right and merging is wrong. Today the responder
declines on timeout, so it does not.

## 5. Implementation surface

| file | change |
|---|---|
| `packages/realtime-audio-ws/src/strip.ts` | the container: docked 1U strip, faceplate styling, 58px collapsed geometry |
| `packages/realtime-audio-ws/src/client/index.ts` | `renderStrip` (line ~608): collapsed row, the toggle, the three levels, toggle/list/timeout controls |
| `packages/realtime-audio-ws/tests/strip.spec.ts` | asserts the current markup — will need updating, and it also asserts neither payload carries a closing script/style tag |
| `packages/realtime-audio-ws/tests/client.spec.ts` | `renderStrip`'s output; the per-file 100% coverage bar applies to new branches |

**Do not** move the panel's logic into the injected string. `strip.ts` mints rows; everything that *decides*
what to render belongs in the client bundle, where CI can execute it.

## 6. Verification

- **A screenshot of the running app is the only detector for appearance.** jsdom has no compositor, so no DOM
  assertion can see what is painted behind or around an element. The first report of the earlier translucent
  panel came from a screenshot, and this design is *more* opinionated, so the check matters more, not less.
- **Keep a paint guard** asserting the markup's background is never transparent — the regression that made
  the two texts superimpose, which no DOM test could see.
- The functional assertions (toggle state, list edit, the timeout pair written and re-read) go in the client
  spec, where they are executable.

## 7. Sequencing

**Build the GUI first, then do one in-app run that tests the GUI *and* the write path together.** Both need an
install and a restart of the app, and doing it once for two subjects is strictly better than twice for one.

The write-path run's acceptance criteria are separate and already written down — see the P2a section of the
project note. Its open clauses, which only a real session settles: whether a real `Session.append` accepts
`realtime/change`, whether `flush` returns true, and the `turn/start` pair.

## 8. Not covered here

- **`d)` natural-language settings** — a future feature, and a *constraint on this design*: if you will
  eventually say "make the voice wait longer" in the chat, the panel's job shrinks to **state plus the few
  things worth a knob**. That is the argument against ever putting all eight settings on the faceplate.
- **Story 5's inbox assertions, story 7, P2b, P3** — unrelated to the GUI.
