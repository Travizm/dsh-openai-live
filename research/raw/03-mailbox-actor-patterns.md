# 03 — Mailbox / Actor Messaging Patterns and Delivery Semantics

Research for the `dsh-openai-live` realtime-voice plugin. The plugin gives a voice model two
verbs into a coding-agent session:

- **SILENT NOTE** — model-facing context, does *not* start a turn, not shown in transcript.
- **VISIBLE SAY** — starts a turn, attributed to the voice, shown in transcript.

The design invariant we are mining these sources for:

> **Nothing model-visible may be silently dropped, and nothing may be fabricated.**
> Anything visible to the model must be reconstructable from a durable log.

This file covers (1) Erlang/OTP actor mailboxes, (2) durable-queue delivery semantics,
(3) acknowledgement/checkpointing, (4) idempotency & dedup, (5) log-as-source-of-truth,
(6) pending/byte caps and backpressure. Each pattern has a name, a one-line definition,
and a source URL.

---

## 1. Erlang/OTP actor model — per-process mailbox, selective receive, ordering, supervision

### 1.1 Per-process mailbox (message queue)

**Pattern: Per-Process Mailbox.**
*Definition:* Every Erlang process owns a private, unordered-arrival FIFO message queue; senders
never share memory, they only append signals that the receiver drains with `receive`.

> "Each process has its own input queue for messages it receives. New messages received are put
> at the end of the queue."
> — https://www.erlang.org/doc/system/conc_prog.html

> "When a message signal is received, the action taken is to add the message to the message queue…
> Unless the receiving process has enabled priority messages, all messages are added to the end of
> the message queue."
> — https://www.erlang.org/doc/reference_manual/processes.html

Consequence for the plugin: the mailbox is the **model-facing context buffer**. It is
in-process, non-durable, and unbounded by default — so it cannot itself be the source of truth.

### 1.2 Selective receive

**Pattern: Selective Receive.**
*Definition:* `receive` scans the mailbox front-to-back and removes the **first message
matching any clause**, leaving non-matching messages in place (and skipping past them).

> "…the first message in the queue is matched against the first pattern in the receive. If this
> matches, the message is removed… If there are no more patterns to test, the first message is
> kept in the queue and the second message is tried instead… If the end of the queue is reached,
> the process blocks."
> — https://www.erlang.org/doc/system/conc_prog.html

Consequence: **receive order ≠ arrival order.** A consumer that selectively receives can reorder
observable processing relative to the wire order. If **VISIBLE SAY** and **SILENT NOTE** are
different message shapes, selective receive will let one overtake the other. Do not rely on a
single mailbox to preserve the transcript order of two verb types unless the consumer drains in
strict arrival order.

### 1.3 The ordering guarantee — exactly what is promised, and what is not

**Pattern: Signal Ordering (per-sender, per-receiver).**
*Definition:* The runtime guarantees *only* that signals from **one sender to one receiver** arrive
in send order; it explicitly does **not** order signals between different senders, and messages may
be lost.

> "The only signal ordering guarantee given is the following: if an entity sends multiple signals to
> the same destination entity, the order is preserved; that is, if `A` sends a signal `S1` to `B`,
> and later sends signal `S2` to `B`, `S1` is guaranteed not to arrive after `S2`. **Note that `S1`
> may, or may not have been lost.**"
> — https://www.erlang.org/doc/system/ref_man_processes.html (see also
> https://www.erlang.org/doc/reference_manual/processes.html)

> "Messages corresponding to signals from the same sender will then also be ordered in the same
> order as the signals were sent due to the signal ordering guarantee of the language."
> — https://www.erlang.org/doc/reference_manual/processes.html

**What a mailbox gives:**
- FIFO append order across *all* senders (arrival order), for ordinary messages.
- Total order **per sender→receiver pair** — if A sends S1 then S2, S2 is never observed before S1.

**What a mailbox does NOT give:**
- **No global order** across different senders (A's and C's messages can interleave arbitrarily).
- **No delivery guarantee** — "S1 may, or may not have been lost", and "When communicating over the
  distribution, signals can be lost if the distribution channel goes down." (same URL).
- **No ordering under priority messages.** As of OTP 28, a process may enable priority messages:
  "two messages sent from the same sender may be in a different order from the order in which they
  were sent." — https://www.erlang.org/doc/reference_manual/processes.html
- **No durability.** Mailbox contents die with the process. A crash loses everything queued.

Design implication: a per-sender FIFO guarantee is exactly what a **single voice-producer → single
agent-consumer** channel naturally has. That is the *only* thing we can lean on. For everything the
model must still see after a crash, we need a durable log (§5), not the mailbox.

### 1.4 "Let it crash" + supervision

**Pattern: Let It Crash (Supervision/restart instead of defensive coding).**
*Definition:* Worker processes are written to the happy path; failures are allowed to propagate, and
a **supervisor** detects the exit and restarts the worker in a known-good state.

> "Workers are processes that perform computations and other actual work. Supervisors are processes
> that monitor workers. A supervisor can restart a worker if something goes wrong. The supervision
> tree is a hierarchical arrangement of code into supervisors and workers, which makes it possible to
> design and program fault-tolerant software."
> — https://www.erlang.org/doc/system/design_principles.html

> "A supervisor is responsible for starting, stopping, and monitoring its child processes. The basic
> idea of a supervisor is that it is to keep its child processes alive by restarting them when
> necessary."
> — https://www.erlang.org/doc/system/sup_princ.html

**Pattern: Max Restart Intensity (escalation / give-up).**
*Definition:* A supervisor gives up and terminates itself if restarts exceed a threshold within a
period, pushing the failure up the tree.

> "If more than `MaxR` number of restarts occur in the last `MaxT` seconds, the supervisor terminates
> all the child processes and then itself… The intention of the restart mechanism is to prevent a
> situation where a process repeatedly dies for the same reason, only to be restarted again."
> — https://www.erlang.org/doc/system/sup_princ.html

Design implication: restart means **in-flight mailbox state is gone**. If a VOICE SAY was delivered
to the mailbox and the consumer crashed before the turn completed, a naive "let it crash" restart
*drops* the message — violating "cannot silently drop". This is precisely why the durable log +
idempotent replay (§4, §5) must sit behind the actor, not inside it. ("Let it crash" is the
community name for this OTP supervision philosophy; the *mechanism* — restart, intensity limits,
escalation — is what the cited OTP docs document.)

---

## 2. Durable queues — delivery semantics (at-least-once / at-most-once / exactly-once)

**Pattern: At-Most-Once.**
*Definition:* Deliver once at most; on failure the message may be lost, never retried.
> "At most once: Messages are delivered once, and if there is a system failure, messages may be lost
> and are not redelivered."
> — https://docs.confluent.io/kafka/design/delivery-semantics.html
> "You can implement at-most-once delivery by disabling retries on the producer and committing
> offsets in the consumer before processing a batch of messages." (same URL)

**Pattern: At-Least-Once.**
*Definition:* Deliver one or more times; never lost, but duplicates are possible.
> "At least once: This means messages are delivered one or more times. If there is a system failure,
> messages are never lost, but they may be delivered more than once."
> — https://docs.confluent.io/kafka/design/delivery-semantics.html

**Pattern: Exactly-Once (and why it is really at-least-once + idempotent consumer).**
*Definition:* Each message takes effect exactly once; implemented as at-least-once transport plus a
dedup/idempotency layer, not as a magic transport property.
> "It's impractical to guarantee exactly-once delivery across a distributed system. Even brokers that
> use exactly-once semantics can guarantee only operations they directly control… The durable solution
> isn't to eliminate duplicate delivery but to make the consumer process it correctly. **When you
> combine at-least-once delivery with a consumer that ignores duplicates, you achieve effectively-once
> processing.**"
> — https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer
> "Exactly once semantics has two parts: avoiding duplication during data production and avoiding
> duplicates during data consumption… Include a primary key (UUID or something) in the message and
> deduplicate on the consumer."
> — https://cwiki.apache.org/confluence/spaces/KAFKA/pages/33293069/FAQ

### 2.1 Producer idempotence

**Pattern: Idempotent Producer (producer-id + sequence number).**
*Definition:* The broker assigns the producer an id and dedups retried writes by per-partition
sequence number, so a resend cannot create a duplicate in the log.
> "The broker assigns each producer an ID and deduplicates messages using a sequence number that is
> sent by the producer with every message."
> — https://docs.confluent.io/kafka/design/delivery-semantics.html
> "Every new producer will be assigned a unique PID during initialization… The broker will reject a
> produce request if its sequence number is not exactly one greater than the last committed message
> from that PID/TopicPartition pair. Messages with a lower sequence number result in a duplicate
> error, which can be ignored by the producer."
> — https://cwiki.apache.org/confluence/spaces/KAFKA/pages/66854913/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging
> "Producers using transactional messages… enable idempotence… `enable.idempotence` … requires
> `max.in.flight.requests.per.connection` to be ≤ 5 … `retries` > 0, and `acks` must be 'all'."
> — https://kafka.apache.org/42/configuration/producer-configs/

**Pattern: Transactional Producer / TransactionalId.**
*Definition:* A durable producer identity lets multi-partition writes and the consumer-offset commit
land as one atomic unit; a new instance with the same `transactional.id` fences the old one.
> "the TransactionalId … allows the client to guarantee that transactions using the same
> TransactionalId have been completed prior to starting any new transactions."
> — https://kafka.apache.org/42/configuration/producer-configs/
> "Exactly one active producer with a given TransactionalId. This is achieved by fencing off old
> generations when a new instance with the same TransactionalId comes online."
> — https://cwiki.apache.org/confluence/spaces/KAFKA/pages/66854913/…

> Caveat: Kafka transactions only cover Kafka-in→Kafka-out; "if you are calling an external service
> (e.g., via HTTP), updating a database… transactional guarantees won't apply and calls can be
> duplicated." — https://developer.confluent.io/learn/kafka-transactions-and-guarantees/
> That boundary matters for us: the voice model's *say* leaves Kafka the moment it becomes a turn.

### 2.2 Consumer offsets / checkpointing

**Pattern: Consumer Offset / Checkpoint.**
*Definition:* A consumer records its position in the log; on restart it resumes from the last
committed offset, and whether a record is reprocessed depends on when the offset was committed
relative to the side effect.
> "At least once - … if the consumer process crashes after processing messages, but before saving
> its position, the new process that takes over may process some messages a second time."
> — https://docs.confluent.io/kafka/design/delivery-semantics.html
> "the consumer's position is stored as a message in a topic, so offset data is written to Kafka in
> the same transaction as when processed data is written to the output topics."
> — https://docs.confluent.io/kafka/design/delivery-semantics.html

### 2.3 Acknowledgement (ack / nack / reject) and requeue

**Pattern: Consumer Acknowledgement (ack / nack / reject).**
*Definition:* The consumer tells the broker a delivery was handled (`basic.ack`), or negatively
acknowledges it (`basic.nack` / `basic.reject`), optionally requeueing.
> "`basic.ack` is used for positive acknowledgements; `basic.nack` is used for negative
> acknowledgements (note: this is a RabbitMQ extension to AMQP 0-9-1); `basic.reject` … has one
> limitation … Positive acknowledgements simply instruct RabbitMQ to record a message as delivered
> and can be discarded."
> — https://www.rabbitmq.com/docs/confirms
> "In automatic acknowledgement mode, a message is considered to be successfully delivered
> immediately after it is sent… if consumer's TCP connection or channel is closed before successful
> delivery, the message sent by the server will be lost. Therefore, automatic message acknowledgement
> should be considered unsafe."
> — https://www.rabbitmq.com/docs/confirms

**Pattern: Automatic Requeueing on Connection Loss.**
*Definition:* Unacked deliveries are requeued automatically when a consumer channel/connection dies,
which is the operational reason a consumer must tolerate redelivery.
> (Documented in the "When Consumers Fail or Lose Connection: Automatic Requeueing" section of
> https://www.rabbitmq.com/docs/confirms)

**Pattern: Publisher Confirms.**
*Definition:* Broker-side acknowledgement back to the producer that a message reached the queue/disk,
the producer-side half of reliable delivery.
> "publisher acknowledgements are emitted asynchronously… acknowledgements can arrive in a different
> order compared to their respective messages. Applications should not depend on the order of
> acknowledgements."
> — https://www.rabbitmq.com/docs/confirms

### 2.4 Visibility timeout (the "in-flight" lease)

**Pattern: Visibility Timeout.**
*Definition:* A received-but-not-deleted message becomes invisible for a lease period; if not deleted
in time it reappears for redelivery.
> "When you receive a message from an Amazon SQS queue, it remains in the queue but becomes
> temporarily invisible to other consumers… If you don't delete it before the timeout expires, the
> message becomes visible again in the queue and can be retrieved by another consumer. The default
> visibility timeout for a queue is 30 seconds… maximum limit of 12 hours from when the message is
> first received."
> — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html

> Important nuance for "cannot silently drop": because of at-least-once delivery, "there's no
> absolute guarantee that a message won't be delivered more than once during the visibility timeout
> period." (same URL)

### 2.5 Dead-letter queues

**Pattern: Dead-Letter Queue / Dead-Letter Exchange.**
*Definition:* Messages that are rejected, expire, or exceed a retry/queue limit are republished to a
separate destination instead of being dropped, so failures are inspectable.
> "Messages from a queue can be 'dead-lettered'… when any of the following four events occur: 1. The
> message is negatively acknowledged… 2. The message expires due to per-message TTL, or 3. The message
> is dropped because its queue exceeded a length limit, or 4. The message is returned more times to a
> quorum queue than the delivery-limit."
> — https://www.rabbitmq.com/docs/dlx
> DLX safety: "messages can be lost if the target queue is not available to accept messages. Quorum
> queues support at-least-once dead-lettering where messages are re-published with publisher confirms
> turned on internally." (same URL)

Design implication: for **VISIBLE SAY**, a DLQ is the "we refused to deliver this turn" quarantine —
better a visible dead-letter than a silent drop. For **SILENT NOTE**, a DLQ is less useful (context
that never reached the model is either reapplied or discarded) but should still be logged.

---

## 3. Acknowledgement / checkpointing patterns — delivered vs handled; inbox/outbox; transactional outbox

**Key distinction:** *delivered* (reached the consumer's buffer) ≠ *handled* (side effect committed).
Durable systems must record **handled**, and make that record atomic with the side effect.

**Pattern: Delivered vs Handled acknowledgement.**
*Definition:* An ack means "the side effect is committed", not "the bytes were read"; acking before
the effect (auto-ack) is the classic loss window.
> "Positive acknowledgements… instruct RabbitMQ to record a message as delivered and can be
> discarded." vs auto-ack: "the message sent by the server will be lost."
> — https://www.rabbitmq.com/docs/confirms

**Pattern: Transactional Outbox.**
*Definition:* Write the outgoing event into an outbox table **in the same transaction** as the
business state change; a separate relay publishes it and marks it sent, so the event is emitted iff
the state change committed.
> "the service that sends the message … first store[s] the message in the database as part of the
> transaction that updates the business entities. A separate process then sends the messages to the
> message broker."
> — https://microservices.io/patterns/data/transactional-outbox.html
> "Messages are guaranteed to be sent if and only if the database transaction commits… The Message
> relay might publish a message more than once… a message consumer must be idempotent."
> — same URL
> "In the transactional outbox pattern, a second persistent data store is introduced to store the
> outgoing messages… updating the database with order details and storing the event information in
> the outbox table becomes a single atomic transaction."
> — https://aws.amazon.com/blogs/compute/implementing-the-transactional-outbox-pattern-with-amazon-eventbridge-pipes/

**Pattern: Dual-Write Problem.**
*Definition:* The bug the outbox exists to fix — two independent writes (state + notification) where a
failure between/after them desynchronises the two systems.
> "The dual-write problem occurs when two external systems must be updated in an atomic fashion… If a
> failure occurs after the data has been saved but before the event makes it to Kafka, the system can
> end up in an inconsistent state."
> — https://www.confluent.io/blog/dual-write-problem/

**Pattern: Inbox (Transactional Inbox).**
*Definition:* The consumer-side companion to the outbox — persist the incoming message / dedup key
and its side effect **in one transaction**, so redelivery is a no-op.
> "Avoid this failure window by writing the deduplication marker and the business side effects in the
> same transaction… This transactional variant is the Inbox pattern, and is the consumer-side
> companion to the producer Transactional Outbox pattern."
> — https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer

**Pattern: Listen-To-Yourself.**
*Definition:* Write the command's event directly to the log first; a separate process consumes it to
update state — the log is the write path (sacrifices read-your-writes).
> "the listen-to-yourself pattern writes directly to Kafka… A separate process can listen to these
> events and use them to update the database, retrying as necessary."
> — https://www.confluent.io/blog/dual-write-problem/

### 3.1 Application to the AGENT case

For `dsh-openai-live` the "database" whose state must change atomically with delivery is **the
session transcript / durable log**:

- **VISIBLE SAY** must do outbox+inbox: (a) append the thought to the durable log **and** (b) record
  it as applied to the model's context, atomically. A turn is started only after the record commits.
  On restart, replay from the log re-materialises context — no drop, no fabrication.
- **SILENT NOTE** is model-facing context only. It must still be logged (so the model's inputs are
  reconstructable), but it does **not** gate a turn. This maps to a log append that is applied to
  context without emitting a transcript turn — the "listen to yourself" write-first shape applied to
  context instead of state.
- The failure window to close is the dual-write one: "wrote to the log" vs "delivered to the running
  consumer" must not be two independent writes.

---

## 4. Idempotency and dedup — minted message ids, dedup windows

**Pattern: Minted Message ID (producer-assigned, stable across redelivery).**
*Definition:* Every message carries a producer-minted identifier that is stable across retries, used
as the dedup key.
> "The deduplication key must uniquely and consistently identify the logical message across every
> redelivery. Use either a producer-assigned message identifier or a business-level idempotency key…
> Don't key on transport-level identifiers that the broker regenerates upon redelivery, or on values
> derived from delivery attempts."
> — https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer

**Pattern: Idempotent Consumer (processed-messages / inbox table).**
*Definition:* The consumer records the IDs of messages it has processed; a redelivery whose ID is
already present is discarded.
> "Make a consumer idempotent by having it record the IDs of processed messages in the database… the
> message handler inserts the message's ID into the `PROCESSED_MESSAGE` table. Since the
> `(subscriberId, messageID)` is the `PROCESSED_MESSAGE` table's primary key the `INSERT` will fail
> if the message has been already processed."
> — https://microservices.io/patterns/communication-style/idempotent-consumer.html

**Pattern: Dedup Window (bounded retention of dedup records).**
*Definition:* Dedup keys are retained for a finite window; the window must exceed the maximum
redelivery / DLQ-replay horizon or duplicates re-appear.
> "If you retry the `SendMessage` action within the 5-minute deduplication interval, Amazon SQS
> doesn't introduce any duplicates into the queue." (SQS FIFO dedup window = 5 minutes)
> — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html
> "Retain each record at least as long as the broker can still redeliver the original message… Set a
> time-to-live on deduplication records that exceeds this window, so that a late redelivery still
> finds its marker. Deleting records too early reopens the window for duplicates. Account for
> messages that operators resubmit from dead-letter queues."
> — https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer
> "Prune dedup rows — but keep them longer than your redelivery window… pruning a row whose message is
> still in flight would let a duplicate through." — https://relay.nuvoralabs.com/articles/inbox/

**Pattern: Atomic Key Claim (uniqueness constraint, not check-then-set).**
*Definition:* Let the datastore enforce single-processing with a unique constraint, so concurrent
duplicate deliveries race and exactly one wins.
> "Use a uniqueness constraint on the deduplication key such that two transactions can attempt to
> insert a key, but only one can succeed… This approach makes the database the single arbiter of the
> conflict." — https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer

Design implication: every **VISIBLE SAY** and **SILENT NOTE** gets a minted id at the producer
(the voice bridge), persisted in the log. The agent-side consumer dedups on it. The dedup window
must outlive the longest possible reconnect/replay, or a reconnected voice client's resend could
double-start a turn.

---

## 5. "The log is the source of truth" — event sourcing, replay, provenance

**Pattern: Log as Source of Truth (append-only log).**
*Definition:* A durable, ordered, append-only log is the authoritative record; all derived state
(caches, indices, context windows) is rebuilt by replaying it.
> "In this model, the log is the source of truth: the serving nodes… blindly transcribe the feed
> provided by the log to their own store. A failed node can be restored by replaying the upstream log."
> — https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying
> "You can think of the log as acting as a kind of messaging system with durability guarantees and
> strong ordering semantics… It's worth emphasizing that the log is still just the infrastructure."
> — same URL (also mirrored at https://www.oreilly.com/content/i-heart-logs-realtime-stream-processing/)

**Pattern: Event Sourcing.**
*Definition:* Persist state as an ordered sequence of state-changing events; current state is a fold
over the log, which is never mutated.
> "Event sourcing persists the state of a business entity… as a sequence of state-changing events.
> Whenever the state of a business entity changes, a new event is appended to the list of events…
> The application reconstructs an entity's current state by replaying the events."
> — https://microservices.io/patterns/data/event-sourcing.html
> "It provides a 100% reliable audit log of the changes made to a business entity… It makes it
> possible to implement temporal queries that determine the state of an entity at any point in time."
> — same URL
> "The key to Event Sourcing is that we guarantee that all changes to the domain objects are initiated
> by the event objects… Complete Rebuild: We can discard the application state completely and rebuild
> it by re-running the events from the event log… Event Replay: … The same technique can handle events
> received in the wrong sequence."
> — https://martinfowler.com/eaaDev/EventSourcing.html

**Pattern: Snapshot + Replay (compaction).**
*Definition:* Periodic snapshots plus events-after-snapshot let you reconstruct state without
replaying the whole log.
> "an application can periodically save a snapshot of an entity's current state. To reconstruct the
> current state, the application finds the most recent snapshot and the events that have occurred
> since that snapshot." — https://microservices.io/patterns/data/event-sourcing.html

### 5.1 Tie to the plugin invariant

> **Anything model-visible must be reconstructable from the log.**

- The log is the single append point for both verbs. **VISIBLE SAY** and **SILENT NOTE** are both
  events in the log, in one total order, each with a minted id (§4).
- The model's live context window is **derived state** — a fold / projection over the log, cacheable,
  discardable, rebuildable. This directly mirrors "a caching server… the log is the source of truth".
- **No fabrication** = every turn's attributed voice text is a row in the log; the transcript is a
  projection, never an independent write. **No silent drop** = the delivery path is a log reader with
  a checkpoint (§2.2); a dropped live delivery is re-read from the log on reconnect.
- Provenance follows for free: each turn carries the id of the log event that produced it
  ("provide a trace of cause and effect across the boundary" — https://github.com/thatjimmi/relay).

---

## 6. Pending caps / backpressure / byte caps — one producer cannot flood a consumer's inbox

**Pattern: Bounded Inbox / Prefetch (QoS).**
*Definition:* Cap the number of unacknowledged deliveries in flight to a consumer, so a fast producer
cannot overwhelm a slow consumer.
> "AMQP 0-9-1 specifies the `basic.qos` method to make it possible to limit the number of
> unacknowledged messages on a channel (or connection) when consuming (aka 'prefetch count')…
> applies separately to each new consumer." — https://www.rabbitmq.com/docs/consumer-prefetch
> "With automatic acknowledgements, however, there is no such limit by definition. Consumers therefore
> can be overwhelmed by the rate of deliveries, potentially accumulating a backlog in memory and
> running out of heap." — https://www.rabbitmq.com/docs/confirms

**Pattern: Queue Length / Byte Cap with Overflow Policy.**
*Definition:* Hard cap on a queue's message count and/or total bytes; the overflow policy decides
whether the oldest are dropped or new publishes are rejected (nack).
> "You can set a maximum length on a queue. The maximum length limit can be set to a number of
> messages, or set to a number of bytes (the total of all message body lengths…), or both."
> "If `overflow` is set to `reject-publish` or `reject-publish-dlx`, the most recently published
> messages will be discarded. In addition, if publisher confirms are enabled, the publisher will be
> informed of the reject via a `basic.nack` message."
> — https://www.rabbitmq.com/docs/maxlength
> Note: `max-length-bytes` is the byte cap; `x-max-length-bytes` is the declaration form; "whichever
> limit is hit first will be enforced." (same URL)

**Pattern: Flow Control (broker-side backpressure).**
*Definition:* The broker throttles a publishing connection that is outrunning downstream queues, so
ingress slows instead of memory growing unbounded.
> "RabbitMQ will reduce the speed of connections which are publishing too quickly for queues to keep
> up… A flow-controlled connection will show a state of `flow`… Channels, queues and other parts of
> the system can apply flow control that eventually propagates back to publishing connections."
> — https://www.rabbitmq.com/docs/flow-control

**Pattern: Log as Unbounded Buffer / Isolation.**
*Definition:* The log decouples producer and consumer rates, absorbing bursts so a slow consumer can
catch up without back-pressuring the whole graph.
> "If a processor produces output faster than its downstream consumer can keep up, we have three
> options: … block, buffer or drop data. Dropping data is likely not an option; blocking may cause the
> entire processing graph to grind to a halt. The log acts as a very, very large buffer."
> — https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying

**Pattern: In-Flight Quota / OverLimit.**
*Definition:* A hard ceiling on received-but-undeleted messages; on breach the queue returns an error
(or withholds new messages) rather than accepting unbounded in-flight work.
> "For standard queues, there's a limit of approximately 120,000 in-flight messages… If you reach
> this limit, Amazon SQS returns an `OverLimit` error… With long polling, Amazon SQS does not return
> an error… Instead, it will not return any new messages until the number of in-flight messages drops
> below the limit."
> — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html

**Related size/retention caps:**
> SQS message size max 1 MiB; message retention 60 s–14 days; message timer (delay) max 15 min.
> — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html

### 6.1 Application to the plugin

A single voice producer must not be able to flood the agent's inbox. The toolkit:
- **Pending cap** on the agent's model-facing queue (unhandled deliveries) — prefetch/QoS analogue.
- **Byte cap** on accumulated SILENT NOTE context, with an explicit overflow policy. Prefer
  **reject-publish + nack** (the voice bridge learns the note was refused) over **drop-head** (silent
  loss), to honour "cannot silently drop". If notes must be summarized/compacted, that compaction is
  itself a logged event — never an unlogged loss.
- **Backpressure back to the voice**: a refused note (nack) or a flow-control signal tells the voice
  bridge to slow down, rather than the agent silently accumulating unbounded context.

---

## Evidence trail (all sources actually fetched)

**Erlang / OTP (primary)**
- Processes — Reference Manual (mailbox, signals, priority messages, no global order):
  https://www.erlang.org/doc/reference_manual/processes.html
- Processes — Signal ordering guarantee text ("S1 may, or may not have been lost"):
  https://www.erlang.org/doc/system/ref_man_processes.html
- Concurrent Programming (per-process mailbox, selective receive, blocks at end of queue):
  https://www.erlang.org/doc/system/conc_prog.html
- OTP Design Principles — Overview (supervision trees, workers/supervisors, behaviours):
  https://www.erlang.org/doc/system/design_principles.html
- Supervisor Behaviour — Supervision Principles + Max Restart Intensity:
  https://www.erlang.org/doc/system/sup_princ.html
- Port Signals — signal ordering guarantee for process↔port (same rule):
  https://www.erlang.org/doc/apps/erts/portsignals.html

**Durable queues / delivery semantics**
- Kafka Message Delivery Guarantees (at-most/at-least/exactly once, producer idempotence, consumer
  offsets): https://docs.confluent.io/kafka/design/delivery-semantics.html
- KIP-98 Exactly Once Delivery and Transactional Messaging (PID + sequence numbers, TransactionalId,
  fencing): https://cwiki.apache.org/confluence/spaces/KAFKA/pages/66854913/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging
- Kafka FAQ (idempotent vs transactional producer; "include a primary key and deduplicate on the
  consumer"): https://cwiki.apache.org/confluence/spaces/KAFKA/pages/33293069/FAQ
- Kafka Producer Configs (`enable.idempotence`, `transactional.id`, acks/retries constraints):
  https://kafka.apache.org/42/configuration/producer-configs/
- Confluent — Transactions & Guarantees (transaction coordinator, read_committed, "transactions only
  work Kafka-in/Kafka-out"): https://developer.confluent.io/learn/kafka-transactions-and-guarantees/
- RabbitMQ — Consumer Acknowledgements and Publisher Confirms (ack/nack/reject, auto-ack loss,
  requeue, publisher confirms ordering caveat): https://www.rabbitmq.com/docs/confirms
- RabbitMQ — Dead Letter Exchanges (dead-lettering events, at-least-once DLX on quorum queues):
  https://www.rabbitmq.com/docs/dlx
- RabbitMQ — Queue Length Limit (`max-length`, `max-length-bytes`, `overflow`, `reject-publish` nack):
  https://www.rabbitmq.com/docs/maxlength
- RabbitMQ — Consumer Prefetch (`basic.qos`): https://www.rabbitmq.com/docs/consumer-prefetch
- RabbitMQ — Flow Control (connection backpressure): https://www.rabbitmq.com/docs/flow-control
- SQS — Visibility Timeout (30 s default, 12 h max, at-least-once during window, in-flight quota):
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html
- SQS — Message Quotas (1 MiB size, 60 s–14 day retention, 15 min timer):
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html
- SQS — Exactly-once processing / FIFO dedup (5-minute dedup interval):
  https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html

**Reliable messaging patterns**
- microservices.io — Transactional Outbox: https://microservices.io/patterns/data/transactional-outbox.html
- microservices.io — Idempotent Consumer:
  https://microservices.io/patterns/communication-style/idempotent-consumer.html
- microservices.io — Event Sourcing: https://microservices.io/patterns/data/event-sourcing.html
- AWS Prescriptive Guidance — Transactional Outbox (dual writes, outbox table + CDC):
  https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html
- AWS Compute Blog — Transactional Outbox with EventBridge Pipes:
  https://aws.amazon.com/blogs/compute/implementing-the-transactional-outbox-pattern-with-amazon-eventbridge-pipes/
- Confluent — Dual-Write Problem (anti-patterns; outbox, event sourcing, listen-to-yourself):
  https://www.confluent.io/blog/dual-write-problem/
- Microsoft Azure Architecture Center — Idempotent Consumer (Inbox pattern, atomic dedup + effect,
  dedup-key rules, dedup-record lifecycle): https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer
- Relay — Inbox pattern in practice (atomic effect+dedup, retention floor, stage-not-save):
  https://relay.nuvoralabs.com/articles/inbox/
- Relay (library) — Transactional Inbox/Outbox, idempotency keys, SKIP LOCKED:
  https://github.com/thatjimmi/relay

**Log as source of truth / event sourcing**
- Jay Kreps — The Log: What every software engineer should know about real-time data's unifying
  abstraction (log as source of truth, replay of failed node, buffer/isolation):
  https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying
  (mirrors: https://www.linkedin.com/blog/engineering/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying ;
  https://www.oreilly.com/content/i-heart-logs-realtime-stream-processing/)
- Martin Fowler — Event Sourcing (complete rebuild, temporal query, event replay):
  https://martinfowler.com/eaaDev/EventSourcing.html

---

## UNVERIFIED / caveats

- **"Let it crash" is community terminology.** The *phrase* does not appear verbatim in the OTP docs
  fetched; the *mechanism* (supervision, restart, intensity/escalation) is documented at
  design_principles.html and sup_princ.html. Treat the name as informal.
- **Kafka docs canonical-domain redirect.** `https://kafka.apache.org/documentation/` and
  `https://kafka.apache.org/documentation/#semantics` returned a JS "Redirecting…" shell via the
  extractor, so the Kafka design/semantics claims here are cited to Confluent's `delivery-semantics`
  page, the KIP-98/F​AQ CWiki pages, and kafka.apache.org producer-configs instead of the design page.
- **SQS FIFO 5-minute dedup** is documented; the exact behaviour of duplicate detection *beyond* that
  window is not guaranteed (SQS is at-least-once). Do not treat the FIFO dedup window as a correctness
  guarantee for turning off consumer-side dedup.
- The specific numeric caps (prefetch value, byte cap, dedup-window length) for `dsh-openai-live` are
  **design decisions not derivable from these sources** — the sources give the *mechanisms* and the
  *failure modes*, not the plugin's chosen constants.
