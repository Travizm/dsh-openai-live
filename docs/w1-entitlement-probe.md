# W1 — gpt-live-1 session handshake: result

**Date:** 2026-10-07 · **Status:** ⛔ **blocked on account credit** (not on capability)
**Probe:** `spike/probe-entitlement.mjs` · **Raw output:** `spike/evidence/w1-probe-raw.txt`

## What was tested

A raw WebSocket to `wss://api.openai.com/v1/live/sessions`, `session.start` with
`{model: gpt-live-1, instructions, audio.output.voice: marin, delegation: {type: client}}`.
The probe prints event names, timings and the accepted config — never the key.

## Observed (verbatim)

| Step | Timing | Result |
|---|---|---|
| socket open | 1204 ms | connected |
| `session.start` sent | 1205 ms | accepted for transport |
| server response | 3158 ms | `error` |

```
{"type":"invalid_request_error",
 "code":"credit_balance_exhausted",
 "message":"You have no credits remaining. Add credits to continue using the API at
            https://platform.openai.com/settings/organization/billing/."}
```

## What this establishes

1. **The endpoint and protocol shape are correct.** The server parsed the client's first
   frame and replied with a *typed, application-level* error in ~1.95 s. It did not reject the
   connection, the path, or the frame as malformed.
2. **Authentication passed.** A `credit_balance_exhausted` error is attributable to a billing
   account; an unauthenticated request cannot reach billing. This is materially different from
   the previously recorded failure mode (`401 missing_authorization`).
3. **Entitlement is confirmed — independently of the session call.** `GET /v1/models` lists
   **`gpt-live-1`** (`shutdown_date: null`, i.e. current, not sunsetting), alongside
   `gpt-live-transcribe`, `gpt-realtime-1.5/2/2.1/mini`, and `gpt-realtime`
   (`shutdown_date: 2027-01-20`).

   That last row matters: `gpt-realtime` carries a shutdown date and `gpt-live-1` does not.
   The upstream strategy — porting `dsh-realtime-voice` off the sunsetting `gpt-realtime`
   family onto `gpt-live-1` — is the right target, confirmed from the account's own model list.

4. **Both stored keys are one key.** `OPENAI_API_KEY` and `VOICE_TOOLS_OPENAI_KEY` share
   **same** credential — confirmed by comparing a one-way fingerprint of each. The fingerprint is not
   recorded here: a credential-derived identifier is exactly the kind of value that does not belong in
   a published document. There is no second key to retry.

## What remains unproven

Nothing about the protocol is disproven — but **no event beyond the error was ever received**,
so `session.started`, audio round-trip, transcripts, and the `session.delegation.created →
response.event` envelope are all still **unverified by observation**. The spike's argument is
not established until a session completes.

Two things the credit error also hides: whether the endpoint validates the session config
*before* or *after* the billing check (so the accepted-field shape is unconfirmed), and whether
`delegation: {type: client}` is the correct discriminator for the delegation envelope.

## The single blocker

`credit_balance_exhausted` — the org has a zero credit balance. This is a billing decision, not
an engineering one, and it is the only thing standing between W1 and a pass.

## Next

1. Add credits to the OpenAI org.
2. `npm run spike:entitlement` → expect `PROBE PASS`.
3. Then W1's second half: stream a real utterance (`say` → `ffmpeg -ar 24000 -ac 1 -f s16le`,
   50 ms frames, base64) and assert transcript + output-audio deltas, and the delegation
   envelope.

Everything else in the build is unaffected by the credit block — the adapter, the conformance
harness, and the keyless-replay CI (which by design runs with **no** key) can all proceed.
