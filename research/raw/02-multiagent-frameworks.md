# Multi-agent framework messaging internals — findings for `dsh-openai-live`

**Purpose:** extract, from primary sources, how five established multi-agent stacks handle the six messaging
hazards that `dsh-openai-live` must solve (infinite reply loops, echo/duplicates, ordering, depth/turn/cycle
limits, termination, identity/spoofing) — and what exact mechanism each one landed on.

**Method:** all claims below are from fetched primary sources (official docs, published module source, GitHub
source). Constants and code fragments are quoted verbatim. Anything I could not verify from a fetched source is
listed in [UNVERIFIED](#unverified). No claim in the body is from memory.

**Relevance framing:** `dsh-openai-live` gives a realtime voice model exactly two verbs — `SILENT NOTE`
(model-facing context, starts no turn) and `VISIBLE SAY` (starts a turn, attributed to the voice). That is
structurally the same problem as "an agent can write into a shared message log, and may or may not schedule a
reply". Every framework below is a worked example of one half of that.

---

## 0. The six hazards, and which framework solved which

| Hazard | Strongest precedent found |
| --- | --- |
| Infinite reply loops | AutoGen Magentic-One stall/loop counter (`_n_stalls` vs `max_stalls`); Claude Code cross-session per-sender rate limit + identical-repeat drop + 50-message inbox cap |
| Echo / duplicates | AutoGen Core runtime drops a published message back to its own sender; LangGraph `add_messages` replace-by-id |
| Ordering | LangGraph `add_messages` merge order + `BinaryOperatorAggregate`; AutoGen runtime-assigned `message_id` (uuid4) |
| Depth / turn / cycle limits | Swarm `max_turns`; Agents SDK `DEFAULT_MAX_TURNS = 10`; AutoGen `max_turns`; LangGraph `recursion_limit`; Claude Code `maxTurns` + spawn depth 3 |
| Termination conditions | AutoGen `TerminationCondition` family (incl. `HandoffTermination`); legacy AutoGen `reply is None → break` |
| Identity / spoofing | AutoGen Core `MessageContext.sender` stamped by the runtime, distinct from the payload's own `source`; Claude Code address disambiguation for duplicate session names |

---

## 1. Microsoft AutoGen

Two layers share one runtime. **Core** is the actor-model, event-driven layer. **AgentChat** is the high-level
team API built on Core. The distinction matters for messaging: AgentChat agents are *not* runtime-managed (the
application constructs them; a wrapper Core agent is needed to put an AgentChat agent under the runtime).

- Core overview ("Agents are developed by using the Actor model… Agents communicate through asynchronous
  messages"): https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/index.html
- Agent & runtime, `RoutedAgent`, `message_handler()`, registration, `AgentId`, and the explicit note that
  AgentChat agents are application-created and need a wrapper Core agent:
  https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/agent-and-agent-runtime.html

### 1.1 How a message triggers a reply

`RoutedAgent.on_message_impl` routes by `type(message)` to the first handler whose router returns True, then
falls back to `on_unhandled_message`. Handlers are marked `@event` (one-way) or `@rpc` (expects a response);
`@rpc` installs `router = lambda _message, _ctx: (_ctx.is_rpc) and (match(...) if match else True)`. `@rpc` with
`strict=True` raises `CantHandleException` on a message-type mismatch.

Source: https://microsoft.github.io/autogen/stable/_modules/autogen_core/_routed_agent.html

### 1.2 Echo — the runtime refuses to deliver a message back to its author

This is the single most quotable anti-loop/anti-echo rule in the corpus, and it is stated in the docs:

> "If an agent publishes a message type for which it is subscribed it will not receive the message it published.
> **This is to prevent infinite loops.**"

Source: https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html

The implementation agrees, in the publish path:

```python
# Avoid sending the message back to the sender
if message_envelope.sender is not None and agent_id == message_envelope.sender:
    continue
```

Source: https://github.com/microsoft/autogen/blob/main/python/packages/autogen-core/src/autogen_core/_single_threaded_agent_runtime.py
(also published at https://microsoft.github.io/autogen/stable/_modules/autogen_core/_single_threaded_agent_runtime.html)

### 1.3 Suppressing a write entirely — `DropMessage` via intervention handlers

There *is* a real "no-write" primitive in modern AutoGen: an `InterventionHandler` can return `DropMessage` from
`on_send` / `on_publish`, and the runtime will not deliver it:

```python
if temp_message is DropMessage or isinstance(temp_message, DropMessage):
    event_logger.info(MessageDroppedEvent(...))
    future.set_exception(MessageDroppedException())
    return
```

`MessageContext` passed to intervention handlers carries `sender`, `topic_id`, `is_rpc`, `cancellation_token`,
`message_id`. This is the mechanism to build against if a "silent note must not produce a turn" invariant has to
be enforced *below* the agent, not by agent instruction.

Source: https://microsoft.github.io/autogen/stable/_modules/autogen_core/_single_threaded_agent_runtime.html

### 1.4 Ordering and message identity

- `MessageContext` is `@dataclass class MessageContext: sender: AgentId | None; topic_id: TopicId | None;
  is_rpc: bool; cancellation_token: CancellationToken; message_id: str`.
  Source: https://microsoft.github.io/autogen/stable/_modules/autogen_core/_message_context.html
- `send_message(message, recipient, *, sender: AgentId | None = None, ..., message_id: str | None = None)`;
  when `message_id is None`, the runtime assigns `message_id = str(uuid.uuid4())`. **The message id is
  runtime-assigned, not payload-supplied** — an agent cannot choose its own id.
  Source: https://github.com/microsoft/autogen/blob/main/python/packages/autogen-core/src/autogen_core/_single_threaded_agent_runtime.py
  and https://microsoft.github.io/autogen/stable/reference/python/autogen_core.html
- Ordering is per-recipient FIFO through the runtime's single message queue; delivery is *async and scheduled*
  (`task = asyncio.create_task(self._process_send(...))`), so cross-agent ordering is not globally total.

### 1.5 Identity / spoofing

The trusted sender is the transport-level `ctx.sender: AgentId | None` ("Agent which sent the message. Should
only be None if this was sent from no agent, such as directly to the runtime externally"). But messages are
user-defined Pydantic/dataclass objects that conventionally carry their **own** `source: str` field, and the
official docs demonstrate routing handlers on that field:

```python
@message_handler(match=lambda msg, ctx: msg.source.startswith("user1"))
```

The docs say: "The above agent uses the `source` field of the message to determine the sender agent. You can
also use the `sender` field of `MessageContext` to determine the sender agent using the agent ID if available."

→ **Payload-level `source` is attacker/modeller-controlled; `ctx.sender` is runtime-stamped.** A framework that
lets the model write a `source`-like attribution field into the payload has an impersonation surface; AutoGen's
own docs permit exactly that pattern in the Core API.

Source: https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html

### 1.6 Termination in AgentChat teams

A `TerminationCondition` "is a callable that takes a sequence of `BaseAgentEvent` or `BaseChatMessage` objects
since the last time the condition was called, and returns a `StopMessage` if the conversation should be
terminated, or `None` otherwise. Once a termination condition has been reached, it must be reset by calling
`reset()`". Conditions are stateful, auto-reset after each run, and combinable with `&` / `|`. For group chats
the condition "is called after each agent responds… the condition is called with the 'delta sequence' of
messages since the last time it was called."

Built-ins (verbatim list): `MaxMessageTermination`, `TextMentionTermination`, `StopMessageTermination`,
`TextMessageTermination`, `HandoffTermination`, `TimeoutTermination`, `SourceMatchTermination`,
`TokenUsageTermination`, `FunctionCallTermination`, `FunctionalTermination`, `ExternalTermination`.

Sources: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html
and https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.conditions.html

### 1.7 `HandoffTermination` — verbatim

```python
class HandoffTermination(TerminationCondition, Component[HandoffTerminationConfig]):
    """Terminate the conversation if a HandoffMessage with the given target is received."""
    def __init__(self, target: str) -> None:
        self._terminated = False
        self._target = target
    async def __call__(self, messages) -> StopMessage | None:
        if self._terminated:
            raise TerminatedException("Termination condition has already been reached")
        for message in messages:
            if isinstance(message, HandoffMessage) and message.target == self._target:
                self._terminated = True
                return StopMessage(content=f"Handoff to {self._target} from {message.source} detected.",
                                   source="HandoffTermination")
        return None
```

Source: https://microsoft.github.io/autogen/stable/_modules/autogen_agentchat/conditions/_terminations.html

Note the semantics: a `HandoffMessage` naming a target that is **not a participant** (typically `"user"`) is
how the team *ends its turn* and yields control back to the application. That is structurally identical to
`VISIBLE SAY` handing the turn back to the human. The docs describe it as "useful when you want to pause the run
and allow application or user to provide input when an agent hands off to them."

### 1.8 The group-chat loop and the turn cap (the core "why it doesn't spin forever" answer)

`BaseGroupChatManager._apply_termination_condition` runs the condition first, then increments the turn counter:

```python
if increment_turn_count:
    self._current_turn += 1
    if self._max_turns is not None:
        if self._current_turn >= self._max_turns:
            stop_message = StopMessage(content=f"Maximum number of turns {self._max_turns} reached.",
                                       source=self._name)
            ...
            return True
```

Source: https://raw.githubusercontent.com/microsoft/autogen/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat_manager.py

**But the default is no cap**, and the docs say so explicitly:

> "termination_condition … Defaults to None. **Without a termination condition, the group chat will run
> indefinitely.** max_turns (int, optional): The maximum number of turns in the group chat before stopping.
> **Defaults to None, meaning no limit.**"

Source: https://microsoft.github.io/autogen/stable/_modules/autogen_agentchat/teams/_group_chat/_round_robin_group_chat.html

→ AutoGen's answer to "infinite agent-to-agent reply loops" is **not** a hard-coded limit. It is a pluggable,
composable, explicitly-configured termination condition, plus an *optional* `max_turns`. Out of the box, two
agents in a `RoundRobinGroupChat` will indeed loop forever. The docs' escape hatch is the termination
condition; the delivery mechanism is one `StopMessage` written into the shared thread.

Group-chat mechanics for ordering: every participant broadcasts its response and subscribes to the group topic,
so "all agents share the same context"; the manager maintains `self._message_thread: List[...]` and extends it
with each delta; the manager (not a participant) selects the next speaker and publishes
`GroupChatRequestPublish`.

Source: https://raw.githubusercontent.com/microsoft/autogen/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat_manager.py

### 1.9 `Swarm` — the handoff team, and what its docs warn about

- "at each turn, the speaker agent is selected based on the most recent `HandoffMessage` message in the context."
- `AssistantAgent(..., handoffs=["flights_refunder", "user"])`; handoffs are generated with the model's tool
  calling, so the tool name is `transfer_to_<agent_name>` and the result is a `HandoffMessage`.
- Handing off to `"user"` **stops the team execution**; the application then injects the human reply back as a
  `HandoffMessage(target=<original requester>)` on a *new* `run_stream` call.
- Explicit warning about concurrent handoffs:
  > "If the model does parallel tool calling, multiple handoffs may be generated at the same time. This can
  > lead to unexpected behavior. To avoid this, you can disable parallel tool calling by configuring the model
  > client… set `parallel_tool_calls=False`."

Source: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html

The termination used in both Swarm examples: `HandoffTermination(target="user") | TextMentionTermination("TERMINATE")`.

### 1.10 Magentic-One — the explicit loop detector

This is the only framework in the corpus with a *semantic* loop detector, not just a counter. The orchestrator
keeps a Progress Ledger and increments `_n_stalls` when the ledger reports no progress **or** reports a loop:

```python
if not progress_ledger["is_progress_being_made"]["answer"]:
    self._n_stalls += 1
elif progress_ledger["is_in_loop"]["answer"]:
    self._n_stalls += 1
else:
    self._n_stalls = max(0, self._n_stalls - 1)

if self._n_stalls >= self._max_stalls:
    await self._log_message("Stall count exceeded, re-planning with the outer loop...")
    await self._update_task_ledger(cancellation_token)
    await self._reenter_outer_loop(cancellation_token)
    return
```

…and the round cap:

```python
if self._max_turns is not None and self._n_rounds > self._max_turns:
    await self._prepare_final_answer("Max rounds reached.", cancellation_token)
    return
```

Defaults, verbatim: `max_turns: int | None = 20` and `max_stalls: int = 3` ("The maximum number of stalls
allowed before re-planning. Defaults to 3.").

Sources: https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_magentic_one_orchestrator.py
and https://github.com/microsoft/autogen/blob/13e144e5/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_magentic_one_group_chat.py

The Magentic-One paper frames it as a budget: "If a loop is detected, or there is a lack of forward progress,
the counter is incremented… this counter-based mechanism gives the agents a limited budget to recover from
small errors". Source: https://arxiv.org/html/2411.04468

### 1.11 Legacy (v0.2) — the literal "no reply" termination

The v0.2 group-chat manager bounds the loop with `max_round` and terminates on a `None` reply:

```python
for i in range(groupchat.max_round):
    groupchat.append(message, speaker)
    ...
    if self._is_termination_msg(message) or i == groupchat.max_round - 1:
        break
    ...
    except NoEligibleSpeakerException:
        # No eligible speaker, terminate the conversation
        break

    if reply is None:
        # no reply is generated, exit the chat
        break
```

Three distinct loop-breakers in one function: (a) round cap, (b) `is_termination_msg` on the message body,
(c) **`reply is None` — the agent choosing not to reply ends the conversation**. Plus
`NoEligibleSpeakerException` when the speaker-transition graph has no outgoing edge.

Legacy per-agent bound: `MAX_CONSECUTIVE_AUTO_REPLY = 100  # maximum number of consecutive auto replies
(subject to future change)`, with `max_consecutive_auto_reply` defaulting to it "When set to 0, no auto reply
will be generated." The `GroupChatManager` itself overrides this to `sys.maxsize` with the comment
`# unlimited consecutive auto reply by default`.

Sources: https://github.com/microsoft/autogen/blob/v0.2.16/autogen/agentchat/groupchat.py and
https://github.com/microsoft/autogen/blob/0.2/autogen/agentchat/conversable_agent.py

**The `reply is None` branch is the cleanest existing precedent for `SILENT NOTE`:** a write that does not
schedule a reply is what ends the exchange. Modern AgentChat does not have this — it relies on
`TerminationCondition` instead, and an `AssistantAgent` turn always emits a chat message.

---

## 2. CrewAI

CrewAI is the least message-oriented of the five: there is no shared transcript and no free-form agent-to-agent
channel. Coordination is a **task graph plus a process policy**, with context passed as *task outputs*.

### 2.1 Sequential vs hierarchical

- Sequential: "Tasks are executed one after the other, following a linear progression"; "the output of one task
  is automatically relayed into the next one, but you can specifically define what tasks' output… should be used
  as context for another task… through the `context` attribute".
- Hierarchical: "a 'manager' agent coordinates the workflow, delegates tasks, and validates outcomes… This
  manager agent can now be either automatically created by CrewAI or explicitly set by the user." Requires
  `manager_llm` or `manager_agent`. "Tasks are not pre-assigned; the manager allocates tasks to agents based on
  their capabilities, reviews outputs, and assesses task completion."
- Default process is `sequential`; `process:` accepts `sequential` | `hierarchical` (an `Enum`).

Sources: https://docs.crewai.com/edge/en/concepts/processes,
https://docs.crewai.com/edge/en/learn/hierarchical-process,
https://docs.crewai.com/edge/en/learn/sequential-process,
https://docs.crewai.com/edge/en/concepts/crews

### 2.2 How context is passed

`Task.context: Optional[List["Task"]]` — "Other tasks whose outputs will be used as context for this task."
Example: `analysis_task = Task(..., agent=analyst, context=[research_task])  # This task will wait for
research_task to complete`. In the JSONC crew format, "`context` is a list of prior task names; **forward
references are rejected** so sequential context stays explicit." `async_execution=True` lets a task run without
blocking, and a later task that names it in `context` will wait for it.

There is no agent-to-agent message. The only inter-agent traffic is (a) task-output relay and (b) the delegation
tools, which exist only when `allow_delegation=True`.

Source: https://docs.crewai.com/edge/en/concepts/tasks

### 2.3 Loop / cycle / depth controls

| Control | Default | Effect |
| --- | --- | --- |
| `max_iter` | **conflicting sources** (see below) | "Maximum iterations before the agent must provide its best answer" |
| `max_retry_limit` | `2` | "Maximum number of retries when an error occurs" |
| `max_execution_time` | `None` | "Maximum time (in seconds) for task execution" |
| `max_rpm` | `None` | "Maximum requests per minute to avoid rate limits" |
| `respect_context_window` | `True` | "Keep messages under context window size by summarizing" |
| `allow_delegation` | `False` | "Allow the agent to delegate tasks to other agents" |
| `max_reasoning_attempts` | `None` | "If None, will try until ready" (i.e. unbounded) |

Sources: https://docs.crewai.com/edge/en/concepts/agents,
https://docs.crewai.com/v1.15.27/en/concepts/agents

**`max_iter` default conflict (both official docs, both fetched):** the *Agents* concept page and the CLI
`AGENTS.md` template both say **20** ("`max_iter` | 20 | Max iterations before best answer");
the *Customize Agents* page says **25** ("Limits the maximum number of iterations (`max_iter`)… with a default
of 25"). The 20 figure is corroborated across more pages, but treat the constant as version-dependent.

Sources: https://docs.crewai.com/edge/en/concepts/agents (20),
https://github.com/crewAIInc/crewAI/blob/main/lib/cli/src/crewai_cli/templates/AGENTS.md (20),
https://docs.crewai.com/v1.15.25/en/learn/customizing-agents (25)

### 2.4 The explicit anti-circular-delegation guidance

CrewAI's own agent-authoring template states the loop-prevention pattern directly — unbounded mutual delegation
is prevented by making specialists non-delegating:

> "Enable delegation with `allow_delegation=True`… Delegation tool: Assign sub-tasks to teammates with
> relevant expertise. Ask question tool: Query colleagues for specific information. **Set
> `allow_delegation=False` on specialists to prevent circular delegation.**"

Source: https://github.com/crewAIInc/crewAI/blob/main/lib/cli/src/crewai_cli/templates/AGENTS.md

CrewAI also moved the default from delegation-enabled to delegation-disabled: "Delegation is now disabled by
default to give users explicit control" / "By default, the `allow_delegation` attribute is now set to `False`".

Sources: https://docs.crewai.com/edge/en/learn/hierarchical-process,
https://docs.crewai.com/v1.15.25/en/learn/customizing-agents

### 2.5 Known failure mode (relevant to ordering/context)

A documented community failure in hierarchical mode: the checker agent does not receive the developer's output
and so regenerates the work — the manager's delegation carries the instruction but the specialist's view of
prior artefacts is not guaranteed. Root-cause advice in-thread: assign an explicit `agent` per task. This is the
same class of bug as a `SILENT NOTE` that the model never sees because it was never entered into the context
the receiving turn reads.

Source: https://community.crewai.com/t/context-sharing-in-hierarchical-mode/832

---

## 3. LangGraph — state channels and reducers

LangGraph is not an agent-messaging system; it is a **state machine over named channels**, which makes it the
best source for the *mechanics* of ordered, de-duplicated, concurrently-written message logs.

### 3.1 The model

- Execution proceeds in discrete **super-steps** (Pregel-inspired): "Nodes that run in parallel are part of the
  same super-step… At the end of each super-step, nodes with no incoming messages vote to `halt`…
  **The graph execution terminates when all nodes are `inactive` and no messages are in transit.**"
- Each key in `State` has its own reducer. "Every reducer is a binary function with two positional arguments:
  Left argument: The current value already stored in state for that key. Right argument: The update for that key
  returned by a node." `new_value = reducer(left=current_state[key], right=node_update[key])`.
- "If no reducer function is explicitly specified then it is assumed that all updates to that key should
  override it. The default reducer discards the left argument and keeps only the right."
- `operator.add` (or any binary operator) accumulates: `bar: Annotated[list[str], add]`.

Source: https://docs.langchain.com/oss/python/langgraph/graph-api

### 3.2 `add_messages` — append-only with replace-by-id (the dedupe mechanism)

Docstring verbatim:

> "Merges two lists of messages, updating existing messages by ID. **By default, this ensures the state is
> 'append-only', unless the new message has the same ID as an existing message.**"

Merge semantics from the source:

```python
merged_by_id = {m.id: i for i, m in enumerate(merged)}
ids_to_remove = set()
for m in right:
    if (existing_idx := merged_by_id.get(m.id)) is not None:
        if isinstance(m, RemoveMessage):
            ids_to_remove.add(m.id)
        else:
            ids_to_remove.discard(m.id)
        merged[existing_idx] = m          # same id -> overwrite in place, do NOT append
    else:
        if isinstance(m, RemoveMessage):
            raise ValueError(f"Attempting to delete a message with an ID that doesn't exist ('{m.id}')")
        merged_by_id[m.id] = len(merged)
        merged.append(m)
```

- Messages arriving without an id get one: `if m.id is None: m.id = str(uuid.uuid4())`.
- `REMOVE_ALL_MESSAGES` wipes the accumulated list before the rest of the update is applied.
- `RemoveMessage(id=...)` tombstones an existing message so edits and deletions are expressible without
  mutating the list.

Sources: https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/graph/message.py,
https://docs.langchain.com/oss/python/langgraph/graph-api

**Decision-relevant consequence:** replacing by id is the *only* dedupe in the system — two identical message
bodies with different ids both survive, and a message that reuses an existing id silently **overwrites** the
original. So id allocation is a correctness *and* integrity boundary, not a formatting detail.

### 3.3 Message id stability (a bug class worth knowing about)

`add_messages` historically assigned ids during reduction, which runs *after* checkpoint serialisation starts.
The fix (commit `5d5a641`, PR #7913) moves it earlier:

> "Applications depend on stable message IDs — LangSmith traces, message views, and `RemoveMessage` all break
> when the same message gets a different ID on every load… **Add `ensure_message_ids(value)` to
> `pregel/_messages.py` and call it in `put_writes()` for DeltaChannel writes before submitting to the
> background executor.** This assigns UUIDs synchronously so the serialised bytes always carry a stable ID."

Also quoted: "In the default durability mode, `put_writes()` submits checkpoint writes to a background thread
before `apply_writes()` runs… Every `get_state()` call then replays `id=None` and assigns a fresh UUID — the
same message has a different ID on every load and across every resumed invocation."

Source: https://github.com/langchain-ai/langgraph/commit/5d5a64120e31c23655755985df48568e6b23a978

### 3.4 Concurrent writes to the same channel

Without a reducer, two parallel writes to one key are an error, not a last-write-wins:

> "`langgraph.errors.InvalidUpdateError: At key 'appName': Can receive only one value per step. Use an
> Annotated key to handle multiple values.`"

Source: https://docs.langchain.com/oss/python/langgraph/errors/INVALID_CONCURRENT_GRAPH_UPDATE and
https://github.com/langchain-ai/langgraph/discussions/2975

With a reducer, writes within a super-step are folded through it. `BinaryOperatorAggregate.update(values)`
applies the operator over the batch, and permits at most **one** `Overwrite` per super-step:

```python
seen_overwrite: bool = False
for value in values:
    is_overwrite, overwrite_value = _get_overwrite(value)
    if is_overwrite:
        if seen_overwrite:
            msg = create_error_message(
                message="Can receive only one Overwrite value per super-step.",
                error_code=ErrorCode.INVALID_CONCURRENT_GRAPH_UPDATE)
            raise InvalidUpdateError(msg)
        self.value = overwrite_value
        seen_overwrite = True
        continue
    if not seen_overwrite:
        self.value = self.operator(self.value, value)
```

Source: https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/channels/binop.py

Documented rule: "When nodes execute in parallel, only one node can use `Overwrite` on the same state key in a
given super-step. If multiple nodes attempt to overwrite the same key in the same super-step, an
`InvalidUpdateError` will be raised." And in the TS schema: `UntrackedValue` with `guard: true` (default)
"Throws if multiple nodes write in same step".

Sources: https://docs.langchain.com/oss/python/langgraph/use-graph-api,
https://docs.langchain.com/oss/python/langgraph/graph-api

A silently-lost-write bug in this area was reported and fixed: `channel.update([5, Overwrite(10), 3])` dropped
the `3` with no error; PR #7718 changes it to raise `InvalidUpdateError`.

Sources: https://github.com/langchain-ai/langgraph/issues/7580,
https://github.com/langchain-ai/langgraph/pull/7718

### 3.5 Cycle / turn limits — `recursion_limit`

- "The recursion limit sets the maximum number of super-steps the graph can execute during a single execution.
  Once the limit is reached, LangGraph will raise `GraphRecursionError`. **Starting in version 1.0.6, the
  default recursion limit is set to 1000 steps.**… `recursion_limit` is a standalone `config` key and should
  not be passed inside the `configurable` key."
- "`GraphRecursionError`: Raised when the graph has exhausted the maximum number of steps. **This prevents
  infinite loops.**"
- The lc-core constant is `DEFAULT_RECURSION_LIMIT = 25`.
- LangGraph's own internal default, verbatim from source:
  `DEFAULT_RECURSION_LIMIT = int(getenv("LANGGRAPH_DEFAULT_RECURSION_LIMIT", "10007"))` — note this does **not**
  match the documentation's 1000; see [UNVERIFIED](#unverified).
- Step counter is exposed as `config["metadata"]["langgraph_step"]`.
- Proactive degradation: `from langgraph.managed import RemainingSteps` — "tracks how many steps remain before
  hitting the recursion limit. This allows for graceful degradation within your graph." Documented pattern:
  route to a fallback node when `state["remaining_steps"] <= 2`, rather than letting the graph die on an
  exception.

Sources: https://docs.langchain.com/oss/python/langgraph/graph-api,
https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT,
https://reference.langchain.com/python/langgraph/errors/GraphRecursionError,
https://reference.langchain.com/python/langchain-core/runnables/config/DEFAULT_RECURSION_LIMIT,
https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/langgraph/langgraph/_internal/_config.py

### 3.6 Identity

LangGraph has **no sender identity in the state model**. A message is `{type, id, content, name?, ...}`; the
author is whatever the writer asserts (`name` / `additional_kwargs`). Combined with replace-by-id (§3.2), a node
can both impersonate and overwrite another node's message. LangGraph provides no runtime stamping of authorship —
identity is construction-time convention only. (Mechanism verified from the reducer source; the absence of a
sender-enforcement check was searched and not found — see [UNVERIFIED](#unverified).)

---

## 4. OpenAI Swarm → OpenAI Agents SDK

### 4.1 Swarm's loop (and its unbounded default)

`Swarm.run()` implements the documented loop: "1. Get a completion from the current Agent 2. Execute tool calls
and append results 3. Switch Agent if necessary 4. Update context variables, if necessary 5. If no new function
calls, return."

The loop bound is a turn count over appended history:

```python
def run(self, agent, messages, context_variables={}, model_override=None, stream=False,
        debug=False, max_turns: int = float("inf"), execute_tools=True) -> Response:
    ...
    init_len = len(messages)
    while len(history) - init_len < max_turns and active_agent:
```

Documented default: `max_turns | int | The maximum number of conversational turns allowed | float("inf")`.
**Swarm defaults to unbounded.** Termination is by exhaustion of tool calls: `if not message.tool_calls or not
execute_tools: debug_print(debug, "Ending turn."); break`.

Sources: https://github.com/openai/swarm/blob/main/swarm/core.py,
https://github.com/openai/swarm (README)

### 4.2 Handoff = a tool that returns an `Agent`

> "An `Agent` can hand off to another `Agent` by returning it in a `function`."
> "If an `Agent` calls multiple functions to hand-off to an `Agent`, **only the last handoff function will be
> used**."

In `handle_tool_calls`, a returned `Agent` is turned into a result and an agent switch:

```python
case Agent() as agent:
    return Result(value=json.dumps({"assistant": agent.name}), agent=agent)
...
if result.agent:
    partial_response.agent = result.agent
```

The conversation carries over because `history` is never reset — only the `instructions` (system prompt) swap:
"Only the `instructions` of the active Agent will be present at any given time (e.g. if there is an `Agent`
handoff, the `system` prompt will change, but the chat history will not.)"

The tool is named by the developer, conventionally `transfer_to_<target>` (the README example uses
`transfer_to_sales`). The cookbook names the pattern: "A simple, but surprisingly effective way to do this is by
giving them a `transfer_to_XXX` function… The model is smart enough to know to call this function when it makes
sense to make a handoff." The tool result text is the persona-switch instruction, verbatim:
`f"Transfered to {current_agent.name}. Adopt persona immediately."` (sic) — AutoGen's port uses
`"Transferred to {topic_type}. Adopt persona immediately."`.

Sources: https://github.com/openai/swarm/blob/main/swarm/core.py,
https://github.com/openai/swarm,
https://developers.openai.com/cookbook/examples/orchestrating_agents,
https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/handoffs.html

### 4.3 Identity in Swarm

The sender is **stamped by the framework, not the model**: the response message gets
`message.sender = active_agent.name` before being appended to history, and `Response.messages` are documented as
"Very similar to Chat Completions `messages`, **but with a `sender` field indicating which `Agent` the message
originated from**." The streaming path builds the dict explicitly: `{"content": "", "sender": agent.name,
"role": "assistant", ...}`.

Caveat for our purposes: `messages` (history) is the caller's list, and the framework appends to it rather than
owning it. A caller that seeds `messages` with a fabricated `sender` is not stopped by Swarm. The tool-call
mechanism is the only place where the *model* names a destination, via a tool name the developer registered.

Sources: https://github.com/openai/swarm/blob/main/swarm/core.py,
https://github.com/openai/swarm

### 4.4 Agents SDK (the maintained successor)

- **Handoff is a tool to the LLM.** "Handoffs are represented as tools to the LLM. So if there's a handoff to an
  agent named `Refund Agent`, the tool would be named `transfer_to_refund_agent`."
  `Handoff.default_tool_name()` "resolves to `transfer_to_<agent_name>`".
- **Turn limit, verbatim constant:** `DEFAULT_MAX_TURNS = 10` (in `src/agents/run_config.py` and older
  `src/agents/run.py`). `Runner.run(..., max_turns: int | None = DEFAULT_MAX_TURNS)`. "If we exceed the
  `max_turns` passed, we raise a `MaxTurnsExceeded` exception. Pass `max_turns=None` to disable this turn
  limit." A turn is "one AI invocation (including any tool calls that might occur)".
- **Loop semantics:** "1. If the runner classifies the LLM's output as final output, the loop ends and we return
  the result. 2. If the LLM requests a handoff, we update the current agent and input, and re-run the loop.
  3. If the LLM produces tool calls, we run those tool calls, append the results, and re-run the loop."
- **Conversation carry-over, and the echo guard:** by default "the new agent takes over the conversation, and
  gets to see the entire previous conversation history"; `input_filter` can rewrite it; `agents.extensions.
  handoff_filters.remove_all_tools` is a shipped filter. The nested-history beta documents an explicit
  duplicate-suppression invariant:
  > "Sessions, `RunState`, and `RunResult.to_input_list()` track exact message occurrences moved into this
  > SDK-default history so **those occurrences are not appended twice**; separate identical messages are still
  > preserved."
- **Scope:** "Handoffs stay within a single run. Input guardrails still apply only to the first agent in the
  chain, and output guardrails only to the agent that produces the final output."
- **Name collisions:** `tool_name_collision_policy` default `"warn"` — "logs an actionable warning and exposes
  only the current dispatch winner; `"error"` raises `UserError` before the model is called." This is the
  documented anti-impersonation control for handoff/function name clashes.
- **Data-leak warning attached to handoff history:** "Nested handoff history changes how the transcript is
  represented; it does not redact sensitive data… Treat the receiving agent and its model provider as recipients
  of the forwarded history."

Sources: https://openai.github.io/openai-agents-python/handoffs/,
https://openai.github.io/openai-agents-python/running_agents/,
https://github.com/openai/openai-agents-python/blob/main/src/agents/run.py,
https://github.com/openai/openai-agents-python/blob/cdde4d65/src/agents/run_config.py,
https://openai.github.io/openai-agents-python/ref/run/,
https://developers.openai.com/api/docs/guides/agents/orchestration

**Contrast worth carrying forward:** Swarm defaults `max_turns = float("inf")`; the production SDK that replaced
it defaults to **10**. The turnaround is the clearest evidence in this corpus that an unbounded agent-to-agent
loop is a shipped-bug, not a feature.

---

## 5. Anthropic's agent designs

### 5.1 `Building effective agents` (the patterns doc)

- Orchestrator-workers: "a central LLM dynamically breaks down tasks, delegates them to worker LLMs, and
  synthesizes their results."
- On termination: "The task often terminates upon completion, but **it's also common to include stopping
  conditions (such as a maximum number of iterations) to maintain control.**"
- On autonomy cost: "The autonomous nature of agents means higher costs, and the potential for compounding
  errors. We recommend extensive testing in sandboxed environments, along with the appropriate guardrails."
- Building-block set includes the prompt-chaining, routing, parallelization (sectioning/voting),
  orchestrator-workers and evaluator-optimizer workflows; "Agents" is the only one with its own loop.

Source: https://www.anthropic.com/engineering/building-effective-agents

### 5.2 Multi-agent research system — the concrete numbers

Architecture: "an orchestrator-worker pattern, where a lead agent coordinates the process while delegating to
specialized subagents that operate in parallel." Subagents' *only* outbound channel is returning findings to the
lead; they do not message each other or the user.

Observed failure modes (this is the valuable part):

> "Early agents made errors like **spawning 50 subagents for simple queries**, scouring the web endlessly for
> nonexistent sources, and **distracting each other with excessive updates**."

> "one subagent explored the 2021 automotive chip crisis while 2 others **duplicated work** investigating current
> 2025 supply chains, without an effective division of labor."

The fixes, all prompt-level rather than framework-level:

- **Explicit effort budget:** "Simple fact-finding requires just 1 agent with 3-10 tool calls, direct comparisons
  might need 2-4 subagents with 10-15 calls each, and complex research might use more than 10 subagents."
- **Teach the orchestrator to delegate:** "Each subagent needs an objective, an output format, guidance on the
  tools and sources to use, and **clear task boundaries**."
- **Guardrails:** "We also proactively mitigated unintended side effects by setting **explicit guardrails to
  prevent the agents from spiraling out of control.**"
- **Parallelism bounded:** "the lead agent spins up **3-5 subagents in parallel** rather than serially".

Cost ratio, for budgeting: "agents typically use about 4× more tokens than chat interactions, and multi-agent
systems use about 15× more tokens than chats."

Message-depth handling: the lead writes its plan to Memory because "if the context window exceeds 200,000 tokens
it will be truncated and it is important to retain the plan." Long-horizon pattern: "agents summarize completed
work phases and store essential information in external memory before proceeding to new tasks. When context
limits approach, agents can spawn fresh subagents with clean contexts while maintaining continuity through
careful handoffs." And a direct anti-echo/anti-telephone pattern: "Rather than requiring subagents to
communicate everything through the lead agent, implement artifact systems where specialized agents can create
outputs that persist independently. Subagents call tools to store their work in external systems, then **pass
lightweight references back** to the coordinator. This prevents information loss during multi-stage processing
and reduces token overhead from **copying large outputs through conversation history**."

Source: https://www.anthropic.com/engineering/multi-agent-research-system

### 5.3 Claude Code subagents — depth, concurrency, budget, turn caps

| Limit | Setting | Default | Behaviour at the limit |
| --- | --- | --- | --- |
| Depth | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | `3` layers below the main agent (`1` = no nesting) | "Leaves a subagent at the bottom layer unable to spawn, so it does its delegated work itself." |
| Concurrency | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | `20` | "Refuses to spawn another subagent, returning `Concurrent subagent limit reached`" |
| Spend | `maxBudgetUsd` / `max_budget_usd` | none | "refuses to spawn more subagents, returning `Budget limit reached`, stops background subagents… and ends the query with the `error_max_budget_usd` result subtype" |
| Turns | `maxTurns` on `AgentDefinition` | — | "Maximum number of agentic turns before the agent stops… returns its output **marked as partial**, and you can resume the agent to continue." |

Messaging model: "each subagent runs in its own conversation… intermediate tool calls and results stay inside
the subagent; **only its final message returns to the parent**." The parent→child channel is the Agent tool's
prompt string, and nothing else: "The only content you pass from parent to subagent is the Agent tool's prompt
string."

Sources: https://code.claude.com/docs/en/agent-sdk/subagents, https://code.claude.com/docs/en/sub-agents

Guidance on *stopping*, from Anthropic's own subagent course: the single most effective change is defining an
output format, because "It creates **natural stopping points** — the subagent knows it's done when it has filled
in each section of the format. **It prevents the subagent from running too long.** Without a defined output,
subagents struggle to decide when enough research has been done and tend to run much longer than necessary."
Same principle as AutoGen's `StopMessage` and Swarm's "no tool calls → return": make completion explicit and
structured.

Source: https://academy.claude.com/courses/introduction-to-subagents/designing-effective-subagents

### 5.4 Claude Code cross-session messaging — the closest production precedent to this plugin

This is the only shipped feature in the corpus that is literally "one agent writes a message that another agent
may turn into work", so its safeguards are the most directly transferable.

**Identity is asserted by the transport, not the sender, and the receiver is told so:**

> "When session A messages session B, Claude Code tells B's Claude that the message came from another session,
> **not from you**, and limits what the message can do:
> - It can't approve anything: a message from another session never counts as your consent, so it can't answer
>   a pending permission prompt on your behalf.
> - It can't change configuration: Claude Code instructs the receiving Claude never to change permission
>   settings, `CLAUDE.md`, or other configuration because another session asked.
> - **Commands don't run: a command in the message's text, such as `/compact`, arrives as plain text. Claude
>   Code never executes it.**
> - Permission prompts still fire."

**The loop breaker, verbatim:**

> "**Message loops are throttled:** in the receiving session, Claude Code rate-limits repeated messages per
> sender, **drops identical repeats arriving within a short window**, and **queues at most 50 accepted messages
> for Claude to read**. A message loop between two sessions therefore stops on its own."

**Other hard limits (all enforcement points, not model instructions):**

- "Same-machine message size is capped: Claude Code refuses a message to a session on this machine once its
  serialized form passes about **a million characters**. The refusal names the exact sizes. Nothing reaches the
  receiving session."
- Burst control: "once a rapid burst of messages to a session on this machine reaches what that session's inbox
  accepts, Claude Code refuses further sends in the sending session."
- Inbound triage per message: **Delivered / Held / Refused**, plus a per-session `crossSessionInbound` value
  (`refuse`), and admin-level `permissions.deny: ["SendMessage", "ListAgents"]`.
- Idle subscriptions expire: "If no notice arrives within 12 hours, Claude Code drops the subscription."
- Addressing (anti-ambiguity/anti-spoofing): "Several sessions share the name, or Claude Code couldn't check
  everywhere your sessions run: **Claude adds a short identifier to each row of its listing and uses the
  identifier in the address.**" When more than one live session answers to a mentioned name, "Claude asks you
  which one you mean before sending."
- Delivery never interrupts a tool: "The receiving Claude reads the message between tool calls during an active
  turn, so a running tool is never interrupted. When the receiving session is idle, Claude Code starts a new
  turn with the message." ← this is precisely the `SILENT NOTE` / `VISIBLE SAY` split: a message that arrives
  mid-turn is context; a message that arrives at rest starts a turn.
- Message content is attributed in the transcript: "the preview carries the sender's name and the first line of
  the message… `› Message from @api-worker: Schema migration finished (ctrl+o to expand)`" and "the preview line
  stays in the conversation afterward."
- Agent teams (multi-session coordination) are "experimental and disabled by default. Automated coordination of
  multiple sessions with shared tasks, messaging, and a team lead."

Sources: https://code.claude.com/docs/en/cross-session-messaging, https://code.claude.com/docs/en/best-practices,
https://code.claude.com/docs/en/sub-agents

---

## 6. Synthesis — what this means for `dsh-openai-live`

Ten decisions the corpus actually supports:

1. **`SILENT NOTE` must be a transport-level no-op for turn scheduling.** The closest shipped primitive is
   AutoGen Core's `DropMessage` from an intervention handler (the write is dropped *below* the agent) and the
   legacy `if reply is None: # no reply is generated, exit the chat; break`. Do not implement "no turn" as a
   model instruction; implement it as a property of the write path.
2. **Never deliver a message back to its author.** AutoGen states this as the reason its runtime skips the
   sender on publish, and the docs say it "is to prevent infinite loops".
3. **Stamp attribution in the transport, and accept no attribution field from the model.** AutoGen's
   `MessageContext.sender` is runtime-stamped while the payload's `source` is modeller-controlled — and AutoGen's
   own docs show routing on the spoofable one. The safest design is what the Agents SDK does for handoffs: the
   model may only *choose among registered destinations*, by name, through a tool call.
4. **Allocate message ids in the writer/transport, never let the model choose.** Swarm's agent switch and
   AutoGen's `uuid4` message_id are both framework-assigned. LangGraph shows the failure mode of the alternative:
   same-id means *overwrite*, so a model-chosen id is a message-integrity hazard.
5. **Dedupe must be id-based, with an explicit rule for identical bodies.** LangGraph's `add_messages` keeps two
   identical bodies (different ids) and replaces on id match; Claude Code drops *identical repeats within a short
   window* per sender. Both rules are needed — they solve different problems.
6. **Per-sender rate limiting is the loop breaker that survives a hostile model.** Claude Code: per-sender rate
   limit + identical-repeat drop + at-most-50 queued. Nothing else in the corpus stops a loop that is *not*
   semantically detectable.
7. **Have both a numeric cap and a semantic cap.** Agents SDK `DEFAULT_MAX_TURNS = 10` (was `float("inf")` in
   Swarm); AutoGen `max_turns` (default None, i.e. indefinite) plus a pluggable `TerminationCondition`;
   Magentic-One `max_turns=20` **and** `max_stalls=3` with an `is_in_loop` ledger field; LangGraph
   `recursion_limit` plus `RemainingSteps` for graceful fallback. A numeric cap alone produces truncated output;
   a semantic cap alone can be argued out of by the model.
8. **Termination should be a first-class, composable object with an explicit reason string.** AutoGen returns a
   `StopMessage(content=..., source=...)` and surfaces `stop_reason` on the result
   (`"Maximum number of turns N reached."`, `f"Handoff to {target} from {source} detected."`). LangGraph exposes
   `config["metadata"]["langgraph_step"]`. Make the *reason* observable, not just the fact of stopping.
9. **Ordering: serialize through one log and treat reducer-style concurrent writes as errors, not races.**
   LangGraph raises `InvalidUpdateError: At key '…': Can receive only one value per step. Use an Annotated key to
   handle multiple values.` rather than silently picking a winner — and the one case where it *did* silently
   drop writes (Overwrite followed by a regular update) was filed as a data-loss bug and fixed.
10. **Bound the depth of delegation and the amount of forwarded history explicitly.** Claude Code: spawn depth
    default 3, concurrency 20, budget cap, and each level's context is a deliberate pass-through (only the prompt
    string enters; only the final message returns). The Agents SDK: `input_filter` /
    `handoff_filters.remove_all_tools`, plus an explicit note that forwarded history is a *data disclosure* to
    the receiving agent's model provider, not a redaction.

---

## Evidence trail

Primary sources actually fetched for this file, grouped by framework.

**AutoGen**
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/index.html
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/agent-and-agent-runtime.html
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html
- https://microsoft.github.io/autogen/stable/_modules/autogen_core/_message_context.html
- https://microsoft.github.io/autogen/stable/_modules/autogen_core/_routed_agent.html
- https://microsoft.github.io/autogen/stable/_modules/autogen_core/_single_threaded_agent_runtime.html
- https://github.com/microsoft/autogen/blob/main/python/packages/autogen-core/src/autogen_core/_single_threaded_agent_runtime.py
- https://microsoft.github.io/autogen/stable/reference/python/autogen_core.html
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html
- https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.conditions.html
- https://microsoft.github.io/autogen/stable/_modules/autogen_agentchat/conditions/_terminations.html
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html
- https://microsoft.github.io/autogen/stable/_modules/autogen_agentchat/teams/_group_chat/_round_robin_group_chat.html
- https://microsoft.github.io/autogen/stable/_modules/autogen_agentchat/teams/_group_chat/_base_group_chat.html
- https://raw.githubusercontent.com/microsoft/autogen/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat_manager.py
- https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_magentic_one_orchestrator.py
- https://github.com/microsoft/autogen/blob/13e144e5/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_magentic_one_group_chat.py
- https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.agents.html
- https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.tools.html
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/handoffs.html
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/cookbook/termination-with-intervention.html
- https://github.com/microsoft/autogen/blob/v0.2.16/autogen/agentchat/groupchat.py
- https://github.com/microsoft/autogen/blob/0.2/autogen/agentchat/conversable_agent.py
- https://github.com/microsoft/autogen/discussions/4814
- https://arxiv.org/html/2411.04468 (Magentic-One paper)

**CrewAI**
- https://docs.crewai.com/edge/en/concepts/agents
- https://docs.crewai.com/v1.15.27/en/concepts/agents
- https://docs.crewai.com/edge/en/concepts/processes
- https://docs.crewai.com/edge/en/concepts/tasks
- https://docs.crewai.com/edge/en/concepts/crews
- https://docs.crewai.com/edge/en/learn/sequential-process
- https://docs.crewai.com/edge/en/learn/hierarchical-process
- https://docs.crewai.com/v1.15.25/en/learn/customizing-agents
- https://github.com/crewAIInc/crewAI/blob/main/lib/cli/src/crewai_cli/templates/AGENTS.md
- https://community.crewai.com/t/context-sharing-in-hierarchical-mode/832

**LangGraph**
- https://docs.langchain.com/oss/python/langgraph/graph-api
- https://docs.langchain.com/oss/python/langgraph/use-graph-api
- https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT
- https://docs.langchain.com/oss/python/langgraph/errors/INVALID_CONCURRENT_GRAPH_UPDATE
- https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/graph/message.py
- https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/channels/binop.py
- https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/_internal/_config.py
- https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/langgraph/langgraph/_internal/_config.py
- https://github.com/langchain-ai/langgraph/commit/5d5a64120e31c23655755985df48568e6b23a978
- https://github.com/langchain-ai/langgraph/pull/7718
- https://github.com/langchain-ai/langgraph/issues/7580
- https://github.com/langchain-ai/langgraph/discussions/2975
- https://reference.langchain.com/python/langgraph/errors/GraphRecursionError
- https://reference.langchain.com/python/langchain-core/runnables/config/DEFAULT_RECURSION_LIMIT
- https://reference.langchain.com/python/langgraph/types/Overwrite
- https://reference.langchain.com/python/langgraph/graph/message

**OpenAI Swarm / Agents SDK**
- https://github.com/openai/swarm
- https://github.com/openai/swarm/blob/main/swarm/core.py
- https://developers.openai.com/cookbook/examples/orchestrating_agents
- https://openai.github.io/openai-agents-python/handoffs/
- https://openai.github.io/openai-agents-python/running_agents/
- https://openai.github.io/openai-agents-python/ref/run/
- https://github.com/openai/openai-agents-python/blob/main/src/agents/run.py
- https://github.com/openai/openai-agents-python/blob/cdde4d65/src/agents/run_config.py
- https://developers.openai.com/api/docs/guides/agents/orchestration
- https://openai.github.io/openai-agents-js/guides/handoffs/

**Anthropic**
- https://www.anthropic.com/engineering/building-effective-agents
- https://www.anthropic.com/engineering/multi-agent-research-system
- https://code.claude.com/docs/en/agent-sdk/subagents
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/cross-session-messaging
- https://code.claude.com/docs/en/best-practices
- https://academy.claude.com/courses/introduction-to-subagents/designing-effective-subagents
- https://platform.claude.com/cookbook/patterns-agents-orchestrator-workers

## UNVERIFIED

Items I could not confirm from a fetched primary source, or where sources disagree:

1. **LangGraph's effective default `recursion_limit`.** The docs say "Starting in version 1.0.6, the default
   recursion limit is set to 1000 steps", while the fetched source of
   `libs/langgraph/langgraph/_internal/_config.py` reads verbatim
   `DEFAULT_RECURSION_LIMIT = int(getenv("LANGGRAPH_DEFAULT_RECURSION_LIMIT", "10007"))`. I did not resolve
   which value applies to which release line, or whether `10007` is intentional. `langchain-core`'s own
   constant is separately documented as `DEFAULT_RECURSION_LIMIT = 25`, and the langgraph-sdk schema reference
   says "If not provided, defaults to 25". Three different numbers across four sources — do not hard-code
   without checking the installed version.
2. **AutoGen legacy `GroupChat.max_round` default value.** The loop bound `for i in range(groupchat.max_round)`
   is verbatim from `groupchat.py`, but I did not fetch the default value of `max_round`. (Commonly cited as 10;
   not verified here.)
3. **AutoGen AgentChat message ordering guarantees.** I verified that the runtime schedules delivery with
   `asyncio.create_task` and that per-recipient delivery is queued, but found no documentation guaranteeing a
   global total order across agents. Any ordering claim beyond "queued FIFO per recipient" is unverified.
4. **AutoGen `Swarm`'s multi-handoff race.** The docs warn that parallel tool calling can produce multiple
   simultaneous handoffs and "can lead to unexpected behavior"; the resolved behaviour (last-wins? error?) was
   not verified for the AgentChat `Swarm` team. The OpenAI Swarm README says only the last handoff is used.
5. **LangGraph sender identity.** I verified from the reducer source that messages carry `id`/`type`/`content`
   and that authorship is not part of the merge logic. I found no code that validates or stamps a `name`
   field, but absence of evidence here is weaker than a positive statement — treat "LangGraph does not enforce
   authorship" as a strongly-suggested-but-not-exhaustively-verified conclusion.
6. **Claude Code numeric thresholds.** The rate-limit window, the identical-repeat window, the burst size, and
   the exact per-message character cap are all described qualitatively ("a short window", "about a million
   characters") and the exact constants were not fetched.
7. **CrewAI `max_iter` default (20 vs 25).** Both figures are on official CrewAI doc pages, quoted above; I did
   not fetch the Python source to settle it.
8. **A first-class "no-reply"/`NO_REPLY` primitive in modern AutoGen AgentChat.** I searched for `NO_REPLY` /
   `no_reply` and found none. The modern equivalents I did verify are the `DropMessage` intervention-handler
   path in Core, and the termination-condition family in AgentChat. The literal `if reply is None: break`
   behaviour exists only in the legacy v0.2 line.
