import { describe, expect, it } from 'vitest'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { VOICE_SKILL, VOICE_SKILL_NAME } from '../src/skill.ts'
import { voiceToolDefinitions } from '../src/tools.ts'

/**
 * The skill's own contract, checked against the code rather than against the text.
 *
 * Both halves matter for a different reason. A skill that no longer names a tool is worse than no skill:
 * a model reads it, trusts it, and reaches for something that is not there. A skill that names a tool the
 * plugin does not publish is the same defect from the other side. Neither shows up in a test that only
 * checks the text is non-empty, which is why these read the tool definitions themselves.
 */
describe('the skill this plugin contributes', () => {
  const published = voiceToolDefinitions({} as never).map(definition => definition.name)

  it('addresses itself by a name the registry’s own grammar accepts', () => {
    // The harness's checker, not a local regex: a name that fails the public grammar is rejected at
    // registration, and a hand-rolled pattern would agree with itself and nothing else.
    expect(isSkillName(VOICE_SKILL_NAME)).toBe(true)
    expect(VOICE_SKILL.name).toBe(VOICE_SKILL_NAME)
  })

  it('declares itself a runtime contribution, so a project skill can overrule it', () => {
    // `runtime` is what makes the precedence work: a repository's own `.dsh` skill of the same name wins,
    // which is the right way round for a person writing their own triage notes.
    expect(VOICE_SKILL.source).toBe('runtime')
  })

  it('names every tool it tells the model to call', () => {
    expect(published.length).toBeGreaterThan(0)
    for (const name of published) expect(VOICE_SKILL.content).toContain(name)
  })

  it('names no tool the plugin does not publish', () => {
    // The reverse direction, and the one that rots quietly: a tool renamed and the text left behind reads
    // as an instruction to call something that no longer exists.
    const named = [...new Set(VOICE_SKILL.content.match(/voice_[a-z_]+/gu) ?? [])]
    expect(named.length).toBeGreaterThan(0)
    for (const name of named) expect(published).toContain(name)
  })

  it('carries a routing line short enough to be read in a catalog', () => {
    // A description is a routing decision, and a consumer renders it in a list beside every other skill's.
    expect(VOICE_SKILL.description.length).toBeLessThanOrEqual(200)
    expect(VOICE_SKILL.description.length).toBeGreaterThan(40)
    expect(VOICE_SKILL.whenToUse).toBeDefined()
  })

  it('mentions no journal kind that the plugins do not write', () => {
    // The same drift guard for the record's vocabulary. These are the kinds the running app writes, read
    // from the journal itself rather than from memory; the list is here so a rename fails a test rather
    // than a reader's investigation.
    const written = [
      'answer.received', 'append.acknowledged', 'config.changed', 'config.resolved', 'delegation.received',
      'delegation.seen', 'prompt.admitted', 'prompt.refused', 'session.closed', 'session.failed',
      'session.opened', 'session.requested', 'socket.accepted', 'socket.closed', 'speech.sent',
      'transcript.input', 'window.elapsed',
    ]
    // Every dotted token in the body is journalling's: the text has no other use for a dot, so this reads
    // as one assertion rather than as a filter that has to be right about its own heuristics.
    const named = [...new Set(VOICE_SKILL.content.match(/\b[a-z]+\.[a-z]+\b/gu) ?? [])]
    expect(named.length).toBeGreaterThan(4)
    for (const kind of named) expect(written).toContain(kind)
  })
})
