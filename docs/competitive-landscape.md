# Competitive landscape — DSH realtime voice, and agent-to-agent interop

**2026-10-09.** Method: Exa web search (11 queries), `gh search repos` across three topics, then
**direct verification of the source, package metadata and consumer code** for every claim that
matters. The commands are in the evidence trail at the end so any of this can be re-checked rather
than believed.

**Why this exists.** The sprint plan's S2 and S4 bet on provider-agnosticism and on an in-app control
plane. Those bets were written against an assumed ecosystem. This records what is actually in it, so
the decisions are made against the ecosystem rather than against the roadmap's memory of it.

---

## 1. The direct competitor

**`AlexKaiqi/dsh-realtime-voice`** — v0.3.3, MIT, published to npm, filed under the `dsh-plugin` topic.

> *"Provider-neutral full-duplex voice-agent plugin for DeepSeek Harness. Connects browser audio to
> OpenAI Realtime over WebRTC or Doubao Realtime Duplex over WebSocket while keeping credentials and
> provider protocols behind the DSH Host boundary."*

It is the same capability space as ours, already shipped, with **two providers** behind a seam. Its
route id is `openai/gpt-realtime`.

### Head to head — verified

| | `dsh-realtime-voice` | `dsh-openai-live` |
|---|---|---|
| Version · licence | 0.3.3 · MIT | 0.4.0 · MIT |
| Last publish | **2026-08-31** | 2026-10-08 |
| Last-month downloads | **298** | no reported figure |
| Declared target | DSH **0.1.1-rc.2** | current — composes under the installed toolchain |
| Runtime edges | peer `dsh-multi-model-provider` + `@deepseek-ai/dsh-host-webserver` | **our own packages + `@deepseek-ai/*` peers only** |
| Tests | 8 files, incl. a live e2e | 25 files · 357 tests |
| **CI** | **none** (`.github/workflows` → 404) | full gate: leak scan · build · typecheck · **100 % per-file** · built-artefact smoke |
| Transport | **WebRTC** (OpenAI) + WebSocket (Doubao) | WebSocket only (WebRTC scoped out by design) |
| Browser capture | **AudioWorklet** | `ScriptProcessorNode` — a *documented, deferred* trade |
| Registers model-visible tools | declares `registersTools: false` | **yes** — `voice_start`, `voice_stop` |
| Model route | `openai/gpt-realtime` | `gpt-live-1`, **client delegation** |
| Contract metadata | `plugin-spec.json` + `spec/runtime-contract.json` | neither — **and it should stay that way, see §4** |

### The structural finding

**Its "provider-neutral seam" is not harness API.** `realtimeModelRuntime` and
`dsh-multi-model-provider` appear **nowhere** in the DSH monorepo — verified by grep over `packages/`
and `docs/`. The harness ships **no voice seam at all**, which is the premise this plugin was built
on.

So their seam is **their own two-plugin contract**, and adopting it means adopting their plugin as a
hard runtime edge. Their own README concedes the harness "does not auto-install, activate, or update
peer plugins" — so it is an install of two packages that breaks if either half drifts.

Ours declares no third-party runtime dependency. That is a real difference, and it is the kind that
decides whether a stranger can install the thing.

### Where each side genuinely wins

**Theirs:** packaging presentation and transport coverage. An AudioWorklet capture path, a WebRTC
transport, and a machine-readable `facts` declaration. Also — the number that stings — **298 downloads
a month against our none**.

**Ours:** the gate. *Tests without CI is a claim; a green gate with 100 % per-file coverage, a leak
scan, a built-artefact guard and a protocol canary is evidence.* Plus self-containment, and the
**DSH-native delegation shape**: we admit a turn into a real DSH session through `sessionController`;
theirs routes action requests back to a product-owned agent. Different products sharing a surface —
theirs is *voice for your app*, ours is *voice for your DSH agent*.

---

## 2. Agent-to-agent interop — what already exists

| Repo | What it is | Forkable? | Condition |
|---|---|---|---|
| `firstintent/a2a-bridge` | Star-topology daemon translating **A2A + ACP + MCP**; table explicitly lists **"Hermes Agent \| ACP"** | MIT, TS | ★9, last pushed **Apr 2026**. Hermes *outbound* promised for "v0.2". Reference architecture, **not a dependency**. |
| `block/buzz` | The Nostr relay workspace; `crates/buzz-acp`, `crates/buzz-dev-mcp` | **Apache-2.0**, Rust, ★35.7k | Pushed **2026-10-08**. Alive and forkable — the Buzz option stays cheap. |
| ACP ecosystem | Spec, **official registry**, official **Rust** + **TS** SDKs, dozens of clients | — | Mature. Confirms ACP-first. |
| A2A ecosystem | Spec v1.0-RC, `a2a-python` (★2.2k), `a2a-java`, ~6 MCP↔A2A bridges | Mostly MIT | Well-served if a third party ever demands literal A2A. |
| `study8677/open-gpt-live` | Realtime voice layer, **adaptive VAD**, latency telemetry | MIT, TS | Its VAD is exactly what **ADR-004 forbids**. Value is as a contrast, not a component. |

### Catalogue caution

The DSH plugin *catalogues* disagree with each other by two orders of magnitude. The canonical GitHub
topic `dsh-plugin` holds **~200 repos**; third-party sites advertise **"17,871+"**
(`deepseekharnessplugins.com`), **719** (`dshplugins.co`), and similar (`dshplugin.world`,
`dshplugin.sh`, `deepseekplugins.org`). Two of those are SEO-shaped aggregates.

For S5, the real targets are the GitHub topic, `awesome-dsh-plugin` (★18k curated) and `dsh-market`.
Listing on an aggregator that inflates 200 into 17,871 buys nothing.

---

## 3. ADR-006, corrected

ADR-006 justified an upstream-first strategy on *"a plugin targeting the sunsetting `gpt-realtime`
family at the wrong endpoint."* Checking their route constant:

- **"the sunsetting `gpt-realtime` family" — confirmed.** Their `routeId` is `openai/gpt-realtime`.
- **"at the wrong endpoint" — not supported.** They call official `https://api.openai.com`, with
  `trustedOrigins` pinned to it, and they carry a second vendor (Doubao) alongside.

Half the rationale was right. The amendment is in `decisions.md`; the strategy stands, its stated
reason does not.

---

## 4. Adopt / skip — and one thing *not* to copy

The attractive move is to copy the two JSON files that make their bundle look formal. **Don't** —
and this is the part that needed checking rather than assuming.

| Idea | Verdict | Why |
|---|---|---|
| `plugin-spec.json` | **Skip** | **Nothing reads it.** Not the harness (`grep` over `packages/` + `docs/`), not the installed market plugin (`safer-dsh-market`), not the official authoring docs. `gh search code "plugin-spec.json"` returns only unrelated ecosystems (ToolJet, elizaOS). Adopting it would be cargo-culting one author's private convention — and this skill already records that neither file is required for one-click eligibility. |
| `spec/runtime-contract.json` | **Skip the file, steal the content** | Same: no consumer. But its *content* — required route fields, trusted origins, browser-authorisation markers, same-origin — is a good checklist. We already enforce the equivalent in tests; S4 should *document* it, not JSON-ify it. |
| **AudioWorklet capture** | **Adopt, at its stated trigger** | Not a gap we missed: our client half documents `ScriptProcessorNode` and the reason it deferred a worklet (the app page's `script-src` is unread, and a broken capture path is worse than a slow one). Their shipped worklet is **evidence the swap is safe**, and a reference for it. Trigger: verify the app page's policy, then swap. |
| **WebRTC transport** | **Re-evaluate at S4** | We scoped WebRTC out deliberately (WebSocket only, as the reference implementations do). They demonstrate it working for the OpenAI path. Worth revisiting rather than treating as settled. |
| `facts` capability declaration | **Skip** | Documentation value with no consumer. Our invariants are the contract that bites. |
| Two-plugin install | **Anti-pattern for us** | Self-containment is a differentiator. Do not take a peer-plugin runtime edge. |

**The rule this encodes:** *a file nothing reads is not a contract.* Before adopting an ecosystem
convention, find its consumer. Their specs pass no gate, catch no drift and register nothing.

---

## 5. Implications

1. **Q9 was right and now has evidence.** "Provider-agnosticism as a moat" stays a hypothesis. There
   is a published competitor in the space with two providers, and it is not winning on that basis.
2. **Our defensible claim is narrower and better: DSH-native delegation + engineering rigour.**
   Neither is a moat; both are differences a reviewer can check.
3. **S4's story list stands, with two additions**: the AudioWorklet swap at its trigger, and a
   WebRTC re-evaluation.
4. **The 298-vs-none gap is the honest headline.** On adoption we are behind a plugin with no CI.
   That is a distribution problem, not an engineering one — and it is exactly the problem S5 exists
   to solve. It should not be re-labelled as something else.

---

## Evidence trail

```bash
# the competitor, its seam, and whether the seam is harness API
gh api repos/AlexKaiqi/dsh-realtime-voice --jq '{desc,stargazers_count,pushed_at,license}'
gh api repos/AlexKaiqi/dsh-realtime-voice/contents/package.json --jq .content | base64 -d
grep -rn "realtimeModelRuntime" packages docs          # in ~/dev/deepseek-harness -> empty
grep -rln "dsh-multi-model-provider" packages docs     # -> empty

# is plugin-spec.json consumed by anything?
grep -rIn "plugin-spec\|runtime-contract" packages docs      # -> only unrelated invariant docs
grep -rIn "plugin-spec" ~/.dsh/profiles/desktop/node_modules/safer-dsh-market
gh search code "plugin-spec.json" --limit 20 --json repository,path

# adoption
npm view dsh-realtime-voice version time.modified
curl -s https://api.npmjs.org/downloads/point/last-month/dsh-realtime-voice

# interop
gh search repos --topic agent-client-protocol --limit 40
gh search repos --topic agent2agent --limit 40
gh api repos/firstintent/a2a-bridge/readme --jq .content | base64 -d
gh api repos/block/buzz --jq '{stargazers_count,pushed_at,license}'
```
