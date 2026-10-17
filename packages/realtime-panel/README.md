# `dsh-realtime-panel` — the always-on faceplate

The lamp, the meter and the microphone switch, in `sidebar.footer.action`: chrome that cannot be collapsed, on
both the desktop app and the web client. One job — **the lamp and the mic must be visible without opening
anything** — which rules out every session-scoped seat (they vanish on the New Session screen) and the right
column (the host closes it on narrow windows).

## Provenance, stated plainly

This package was authored in a scratch directory during the faceplate work of 2026-10-16/17 and is preserved here
**as built**:

- `lib/index.js` — the host half, which mints the plate's stylesheet as a row.
- `lib/client/bundle.js` — the client face, hand-authored and heavily commented.
- There is **no `src/`**. The TypeScript the bundle was written in does not survive; what survives is the bundle.

That is a debt, not a design. It is recorded here because the alternative was losing the work entirely when the
scratch directory was pruned, and a package with an honest README is better than a package that quietly has no
source. **When this face next needs changing, rewrite `lib/client/bundle.js` into `src/client/index.ts` against
`dsh-realtime-audio-ws`'s client source** rather than editing the bundle further — and give it the tests it does
not have.

## What it depends on, and why not a package dependency

Two different dependencies, and conflating them is what the first draft of this README did:

- the **renderer** is `require`d from `dsh-realtime-audio-ws` (the tested one, not a copy) — a real
  `dependency`, and the gate caught the manifest omitting it;
- the **state** is read from that face's published global (`globalThis.__realtimePanel`), not from its services,
  because declaring those would gate its start-up — microphone included — and this face must be able to be
  absent without taking the microphone with it.

Two `inject` lists exist at two levels — `dsh.client.inject` in `package.json` lists **package ids**, not service
names — and confusing them is silent.
