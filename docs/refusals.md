# Refusals: what a failure says, and where it sends you

A refusal is the one moment a plugin knows something the person in front of it does not. Everything here
exists so that knowledge survives the trip.

## The shape

A classified failure carries four things, and each answers a different question:

| Field | Answers | Comes from |
|---|---|---|
| `code` | *what kind of problem is this* | our own vocabulary (`INSUFFICIENT_CREDIT`, `CREDENTIAL_REJECTED`, `NOT_ENTITLED`, `RATE_LIMITED`, `NOT_CONFIGURED`, …) |
| `remedy` | *what should I do* | ours, written to be relayed **verbatim**, one imperative sentence |
| `link` | *where do I do it* | the provider's own published page, named in the provider package |
| `providerCode` | *what did the provider actually call it* | the provider, verbatim — never inferred |

The **message is not carried.** A provider's message is where a key turns up — `no credits for key sk-…` is
a real shape — and the plugin that classifies the failure holds no credential to redact against. So the
class is recorded here and the text is left to the adapter, which *does* hold the key and can redact it.

## Why the link is a field and not part of the sentence

The first refusal this system ever captured read `INSUFFICIENT_CREDIT` — add credit, `retryable: false` —
and the URL that would let a person act on it was sitting in the provider's message, which is exactly what
this design refuses to carry. A remedy that says *add credit* without saying *where* is half an
instruction, and it is the half nobody can guess.

So it travels as its own field, from the provider's own table:

```ts
const NO_CREDIT: ProviderFailure = {
  code: 'INSUFFICIENT_CREDIT',
  retryable: false,
  remedy: 'add credit to the OpenAI account — the balance is exhausted',
  link: BILLING_URL,
}
```

## How it reaches a person

Three hops, and each one has been the single point of failure at least once:

1. **The agent returns the refusal** from a session request, and records its `code`, `remedy`, `link` and
   `providerCode` in the journal. The *class* alone is not enough: it cannot distinguish *add credit* from
   *replace the key* from *wait*, which are three different things to do.
2. **The control channel nests it in the reply** rather than flattening it into a sentence.
3. **The panel renders the nested refusal** and nothing else. It used to read only the control-level
   `reason` — a field a *session* refusal never sets — so the failure a user is most likely to meet was
   answered with `refused: no reason given`, at the exact moment the system knew what to do. The page is
   rendered as an anchor, the one `href` the panel emits, and it comes from our own table rather than from
   text a provider sent.

## The rule that keeps this honest

**A remedy names an action; the link names where to take it; neither is optional when a page exists.** If
the provider publishes no page for a class, there is no link — and a panel that emits no anchor is telling
the truth, whereas one that invents a destination is not.

Verified end to end in `packages/realtime-audio-ws/tests/client.spec.ts`: a session refusal with a remedy
and a page renders as `INSUFFICIENT_CREDIT: add credit to the OpenAI account — the balance is exhausted`
followed by an anchor; the same refusal with nothing in it still reads `refused: no reason given` rather
than inventing one.
