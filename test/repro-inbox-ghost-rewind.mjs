// Reproduction: dsh-chat-rewind /undo|/rewind truncates the session log, but
// `agent.inbox.clear()` only durably cancels messages STILL PENDING in the live
// in-memory inbox. Messages the agent had ALREADY claimed before the cut (their
// claim splices are truncated away) keep their insert splices in the kept
// region, so replaying the durable file — as a fresh Inbox does at session
// resume / host restart — leaves them "pending". The api-proxy then pushes
// those rolled-back messages to clients as a phantom "waiting to send" queue
// after the next send or reconnect.
//
// This script drives the REAL replayPendingInbox() helper shipped in
// lib/index.js and mirrors the Inbox constructor's apply/validate semantics and
// the api-proxy queueItems toSpliced projection. It proves:
//   A. a rewind that cuts claims but keeps inserts leaves N ghost rows
//      (replay pending > 0) — the bug that produced the phantom queue;
//   B. appending a removedCount=N canceled splice (the fix) makes the same
//      log replay to an EMPTY inbox — no phantom queue, and the splice is
//      valid under the Inbox replay validator and the api-proxy projection.

import { replayPendingInbox } from "../lib/inbox-replay.js";

// ---- mirror of Inbox.apply/validate from dsh-agent/lib/types/inbox.js ----
// validate(): start + removedCount must be within the current projection.
function applyInboxSplice(state, splice) {
	const { target, start, removedCount = 0, inserted = [] } = splice;
	const list = state[target];
	if (!Number.isSafeInteger(start) || start < 0 || start > list.length) throw new Error("invalid inbox splice");
	if (!Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > list.length) throw new Error("invalid inbox splice");
	return list.toSpliced(start, removedCount, ...inserted);
}

// ---- mirror of api-proxy queueItems() projection (lib/index.js:1877-1885) ----
function projectQueueItems(state, splice) {
	const project = (target) => {
		const messages = state[target];
		return splice?.target === target ? messages.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted) : messages;
	};
	return { "next-turn": project("next-turn"), "next-step": project("next-step") };
}

// Build the pre-rewind log: three user messages queued (inserts at 3,5,7) and
// claimed by the agent (claims would sit after the rewind cut), then a rewind
// cuts to toSeq=8 keeping seq 0..7 — i.e. the three inserts survive but their
// claims are gone. In the real session the live inbox had already claimed them
// in memory, so clear() appended nothing.
const truncatedEvents = [
	{ type: "session", seq: 0, data: {} },
	{ type: "agent/inbox/spliced", seq: 3, data: { target: "next-turn", start: 0, inserted: [{ id: "m1", role: "user", content: "你好，请观察整个项目结构" }] } },
	{ type: "agent/inbox/spliced", seq: 5, data: { target: "next-turn", start: 0, inserted: [{ id: "m2", role: "user", content: "你好，请观察整个结构" }] } },
	{ type: "agent/inbox/spliced", seq: 7, data: { target: "next-turn", start: 0, inserted: [{ id: "m3", role: "user", content: "你好，请观察整个结构" }] } }
];

console.log("=== A. BEFORE FIX: replay the truncated log (the durable file) ===");
const ghosts = replayPendingInbox(truncatedEvents);
console.log("ghost next-turn pending:", ghosts["next-turn"].map((m) => m.id).join(",") || "(none)");
if (ghosts["next-turn"].length !== 3) throw new Error(`expected 3 ghost pending messages, got ${ghosts["next-turn"].length}`);
console.log("  -> 3 ghost rows survive the cut. A fresh Inbox on resume would report hasPending=true,");
console.log("     and the api-proxy would push these rolled-back messages as a 'waiting to send' queue.\n");

console.log("=== B. AFTER FIX: append a removedCount=N canceled splice, then re-replay ===");
// The fix (truncateSession): for each target with ghosts, append a cancel.
const ghostEvents = [...truncatedEvents];
for (const target of ["next-turn", "next-step"]) {
	const count = ghosts[target].length;
	if (count > 0) ghostEvents.push({ type: "agent/inbox/spliced", seq: ghostEvents.length, data: { target, start: 0, removedCount: count, inserted: [], outcome: "canceled" } });
}
const replay = { "next-turn": [], "next-step": [] };
for (const e of ghostEvents) {
	if (e.type !== "agent/inbox/spliced") continue;
	replay[e.data.target] = applyInboxSplice(replay, e.data); // Inbox.apply (validates)
}
console.log("replay pending after fix:", replay["next-turn"].length + replay["next-step"].length);
if (replay["next-turn"].length + replay["next-step"].length !== 0) throw new Error("fix did not empty the replay");
console.log("  -> the canceled splice is VALID under Inbox.apply/validate and empties the inbox.\n");

console.log("=== C. api-proxy projection stays safe with an empty live inbox ===");
const liveInbox = { "next-turn": [], "next-step": [] }; // after agent.inbox.clear()
const cancelSplice = ghostEvents.at(-1).data;
const projected = projectQueueItems(liveInbox, cancelSplice);
console.log("projected queue items after fix:", projected["next-turn"].length, "(no throw; toSpliced clamps)");

console.log("\nPASS: ghost inbox rows are durably canceled by the fix.");
