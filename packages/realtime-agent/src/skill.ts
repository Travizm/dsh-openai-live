/**
 * The voice's triage instructions, contributed to the harness's skill registry at runtime.
 *
 * Contributed in code rather than read from a directory, and that is the one thing that makes it *this
 * plugin's* skill: it appears exactly while the tools it describes are registered, and goes when they do. A
 * file on disk cannot promise that. It would outlive an unloaded row and stand there instructing a model to
 * call tools that no longer exist — the failure mode a skill registry exists to avoid, arrived at by the
 * route that looks most like documentation.
 *
 * The registry files a runtime contribution into the calling context's layer, where a *project* entry
 * outranks it: a repository's own `.dsh` skill of the same name wins, which is the right way round for a
 * person who wants to write their own triage notes.
 *
 * @module dsh-realtime-agent/skill
 */
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/** The name the model addresses it by. Kebab-case, per the registry's own grammar. */
export const VOICE_SKILL_NAME = 'dsh-realtime-voice'

/**
 * What a model should do, in the order that costs least.
 *
 * The body names every tool this plugin publishes, in the order to try them, and the journal kinds worth
 * reading with their real field names. Both halves are checked against the code rather than trusted: the
 * suite fails if a tool is added and the text does not mention it, and if the text names a tool that is not
 * published.
 */
export const VOICE_SKILL: SkillRegistration = {
  name: VOICE_SKILL_NAME,
  description: 'Use when the DeepSeek Harness realtime voice misbehaves — silence, no spoken answer, a session '
    + 'that will not open — or when asked what the voice is configured to do.',
  whenToUse: 'Triaging a voice session that is silent or will not open; reading the voice journal with a person; '
    + 'changing a live voice setting; working out where a spoken turn stopped.',
  source: 'runtime',
  content: `# Voice triage

The DeepSeek Harness realtime voice: the microphone strip, the session it opens, and the model that answers
through it. Work in this order — each step is cheaper than the next, and most conversations are answered by
the second.

1. **\`voice_status\`** — whether a session is open, on which provider and model, and which session it is
   steering. A closed session is the answer most of the time, and it is worth saying so before looking
   further. \`voice_start\` opens one and \`voice_stop\` closes it; both belong *after* the record has been
   read, not instead of reading it.
2. **\`voice_journal\`** — the record, read with the person rather than summarised at them. It carries
   timing, identity and digests and never the conversation's text: the text is in the session log, and a
   journal entry points at it by id.
3. **\`voice_diagnose\`** — five checks in one verdict: credential, route, session, delegation, turn. Run it
   before theorising, and report the check that says \`fail\` rather than the whole table.
4. **\`voice_configure\`** — read what can be changed and what it holds now, and change a \`live\` field. A
   \`session\` or \`restart\` field is refused by the registry with the reason it needs; relay that reason as it
   stands rather than paraphrasing it.
5. **\`voice_probe_provider\`** — last, because it opens a session and spends a little credit. It is the only
   thing that tells a refused credential from an account with no credit from a model the account is not
   entitled to, and those three need different answers.

## Reading the journal

- \`session.requested\` with no \`session.opened\` after it: nothing answered the request. Most often the row
  that would is not mounted, and the session check in \`voice_diagnose\` names which.
- \`session.failed\` carries a **class** and nothing else, on purpose: a provider's message is where a
  credential turns up, so it is not recorded here. Ask \`voice_probe_provider\` for the classified reason.
- \`session.opened\` then \`session.closed\` with no delegation: the provider accepted and then ended it. The
  close entry carries the reason when the provider gave one.
- One spoken turn writes four entries under one id. In file order: \`delegation.received\` (the delegate took
  it, with the offset it took to arrive), \`delegation.seen\` (the agent saw it, with the provider session),
  \`prompt.admitted\` (the request went to the steered session), \`answer.received\` (the answer came back,
  with its length). A gap in that chain is where the turn stopped, and the entry before the gap says why.
- \`delegation.seen\` with no \`answer.received\`: the steered session never answered. Two budgets decide what
  is heard — the agent's \`delegationTimeoutMs\` and the responder's \`answerTimeoutMs\` — and **the smaller
  one wins**.
- \`prompt.refused\` carries the refusal's own reason, written to be relayed. Report it as it stands.
- \`window.elapsed\` marks the response window closing on an item that got no answer in time. It appears only
  where no \`answer.received\` follows.
- \`config.resolved\` is written once per plugin at boot and is the only entry that says what a plugin
  actually read, as opposed to what a profile asked for. It is where a budget change is confirmed.

## Rules

- **Do not restart the app to test a theory.** \`voice_diagnose\` answers most of what a restart would, and a
  restart throws away the journal window you would want to read.
- The journal is append-only and shared with the app. Read it; do not rewrite it, and do not copy its
  entries into anywhere that outlives the question.
- Never print, echo or write a credential. If a question needs one, it is a question for the provider's own
  answer through \`voice_probe_provider\` — never for the text of a key.
`,
}
