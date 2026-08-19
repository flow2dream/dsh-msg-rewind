// Reproduction: dsh-chat-rewind /undo|/rewind truncates the session log but
// leaves dsh-token-meter's per-session fold (TokenMeter.states WeakMap) stale.
// Next compaction then trips the fail-closed guard in
// dsh-compaction-basic/lib/index.js selectCompactableRange() line 383:
//   "compaction: token-meter surface does not match the current session surface"
//
// This script drives the REAL @deepseek-ai/dsh-token-meter service (loaded by
// absolute path from the dsh harness install) and inlines the EXACT guard.
// It proves:
//   A. without invalidation  -> stale fold priced against the cut log -> guard THROWS
//   B. with states.delete()  -> fresh replay from 0 -> guard PASSES

import { Context } from "file:///Users/hai/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js";
import { TokenMeter } from "file:///Users/hai/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js";

// ---- exact guard copied verbatim from dsh-compaction-basic/lib/index.js:379-401 ----
function selectCompactableRange(session, measurement, retainTokens) {
	const pricedNodes = measurement.nodes;
	if (pricedNodes.length === 0) return null;
	const surfaceNodes = session.surface.nodes;
	if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) throw new Error("compaction: token-meter surface does not match the current session surface");
	let accumulated = 0;
	let keepFromIdx = pricedNodes.length;
	for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
		accumulated += pricedNodes[index].tokens;
		keepFromIdx = index;
		if (accumulated >= retainTokens) break;
	}
	if (keepFromIdx === 0) return null;
	return { start: surfaceNodes[0], end: surfaceNodes[keepFromIdx - 1] };
}

// ---- build a synthetic 3-turn session log with a real surface ----
function buildEvents() {
	const e = [];
	e.push({ type: "request/header", seq: 0, data: { header: { config: { provider: "test", model: "test-model", reasoningEffort: 0, temperature: 0, maxTokens: 0 }, system: "You are a concise assistant.", tools: [] } } });
	e.push({ type: "user/message", seq: 1, surfaceOp: "append", data: { role: "user", content: [{ type: "text", text: "Hello" }] } });
	e.push({ type: "step/start", seq: 2, data: { turn: 0, step: 0 } });
	e.push({ type: "assistant/message", seq: 3, surfaceOp: "append", data: { turn: 0, step: 0, message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } } });
	e.push({ type: "step/end", seq: 4, data: { turn: 0, step: 0 } });
	e.push({ type: "user/message", seq: 5, surfaceOp: "append", data: { role: "user", content: [{ type: "text", text: "Tell me about token meters" }] } });
	e.push({ type: "step/start", seq: 6, data: { turn: 1, step: 0 } });
	e.push({ type: "assistant/message", seq: 7, surfaceOp: "append", data: { turn: 1, step: 0, message: { role: "assistant", content: [{ type: "text", text: "A token meter prices surface nodes by replaying the log." }] } } });
	e.push({ type: "step/end", seq: 8, data: { turn: 1, step: 0 } });
	e.push({ type: "user/message", seq: 9, surfaceOp: "append", data: { role: "user", content: [{ type: "text", text: "What happens after rewind?" }] } });
	e.push({ type: "step/start", seq: 10, data: { turn: 2, step: 0 } });
	e.push({ type: "assistant/message", seq: 11, surfaceOp: "append", data: { turn: 2, step: 0, message: { role: "assistant", content: [{ type: "text", text: "The meter's fold must be invalidated." }] } } });
	e.push({ type: "step/end", seq: 12, data: { turn: 2, step: 0 } });
	return e;
}

const ctx = new Context();
const meter = new TokenMeter(ctx); // the live meter that has been folding this session

const session = { id: "session-repro", events: buildEvents() };

// 1) warm the fold on the FULL log (live session before rewind)
const before = meter.measure(session);
console.log("before truncation: surface nodes seq =", before.nodes.map((n) => n.seq).join(","));

// 2) rewind: truncate the shared log (rewind does log.length = toSeq in place)
const toSeq = 5; // keep seq 0..4 -> only turn 0 survives
session.events.length = toSeq;
console.log(`after truncation toSeq=${toSeq} events.length=${session.events.length}`);

// 3) authoritative post-cut surface: a FRESH meter replaying the cut log
//    (what session.surface.nodes is rebuilt to after rewind's cache reset)
const meterRef = new TokenMeter(new Context());
session.surface = { nodes: meterRef.measure(session).nodes.map((n) => n.seq) };
console.log("authoritative post-cut surface nodes seq =", session.surface.nodes.join(","));

// 4) WITHOUT the fix -> stale fold survives the cut (the bug)
console.log("\n[A] WITHOUT invalidation (current plugin before the states.delete fix):");
let stale = meter.measure(session);
console.log("  meter consumedEvents=", stale.logRevision, "priced nodes seq=", stale.nodes.map((n) => n.seq).join(","));
try {
	selectCompactableRange(session, stale, 0);
	console.log("  PASS (unexpected)");
} catch (error) {
	console.log("  THROWS:", error.message);
}

// 5) WITH the fix -> meter.states.delete(session) then re-measure
console.log("\n[B] WITH invalidation (meter.states.delete(session), the shipped fix):");
meter.states.delete(session);
let fresh = meter.measure(session);
console.log("  meter consumedEvents=", fresh.logRevision, "priced nodes seq=", fresh.nodes.map((n) => n.seq).join(","));
try {
	const range = selectCompactableRange(session, fresh, 0);
	console.log("  PASS: guard accepts, range =", range ? `seq ${range.start}..${range.end}` : "null");
} catch (error) {
	console.log("  THROWS:", error.message);
}

// 6) exact-node equality proof (meter seq list == authoritative surface seq list)
const same = fresh.nodes.length === session.surface.nodes.length &&
	fresh.nodes.every((n, i) => n.seq === session.surface.nodes[i]);
console.log("\nfix makes meter.nodes(seq) === session.surface.nodes(seq) :", same);
process.exit(same ? 0 : 1);
