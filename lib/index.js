// dsh-msg-rewind host half.
//
// Registers two conversation-rewind commands:
//   /undo             roll the chat back one full turn (drop the last user
//                     message and everything after it)
//   /rewind [<seq>]   bare: list rewind targets (user messages + their seq);
//                     /rewind <seq>: cut the conversation back to that turn
//                     (keeps events with seq < cut, where cut is the turn's
//                     user message seq when <seq> points inside a turn)
//
// A rewind TRUNCATES the session log — the model context AND the visible
// transcript roll back, and the durable JSONL artifact is rewritten so the
// cut survives a restart. This deliberately goes beyond the compaction
// surface-replace (which only shadows the model view and keeps the human
// transcript), so it manipulates the live Session's internal log/caches and
// the JSONL persistence backend's coordinator cursor. These internals are
// version-sensitive: if a future dsh release renames them, /undo and /rewind
// fail loudly rather than corrupting the log.

import { randomBytes } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { constants, zstdCompress } from "node:zlib";
import { promisify } from "node:util";
import { packChunkRuns } from "@deepseek-ai/dsh-session";

const zstdCompressAsync = promisify(zstdCompress);
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

const name = "msg-rewind";
const inject = ["commands"];

const USAGE_UNDO = "用法：/undo（不带参数）";
const USAGE_REWIND = "用法：/rewind <seq>（seq 见 /rewind 列表；回到该消息，删除它及其之后的所有内容）";

/** Render any thrown value without trusting its string coercion. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Whether the log has a turn/start without a closing turn/end (a stream in flight). */
function hasOpenTurn(events) {
	let depth = 0;
	for (const event of events) {
		if (event.type === "turn/start") depth++;
		else if (event.type === "turn/end") depth = Math.max(0, depth - 1);
	}
	return depth > 0;
}

/**
* Whether an event is a REAL user message (source.kind === "user"). System
* injections (runtime context, skill catalog, compaction notes, memory
* snapshots) are also user/message events with surfaceOp "append", but they
* are plugin-authored — /undo and /rewind must never treat them as the
* "last user turn", or the cut lands after the real user message and the
* transcript keeps it on screen.
*/
function isRealUserMessage(event) {
	return event.type === "user/message"
		&& event.surfaceOp === "append"
		&& event.data?.source?.kind === "user";
}

/** Seq of the last real user message, or undefined when none exists. */
function lastUserMessageSeq(events) {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (isRealUserMessage(event)) return event.seq;
	}
	return void 0;
}

/**
* Resolve a rewind cut from a requested seq: cut at the containing turn's real
* user message when <seq> points inside a turn, else at <seq> itself. cut is
* the first KEPT-exclusive seq — events [0, cut) survive, events [cut, end) drop.
*/
function resolveCut(events, toSeq) {
	let cut = toSeq;
	for (const event of events) {
		if (event.seq > toSeq) break;
		if (isRealUserMessage(event)) cut = event.seq;
	}
	return cut;
}

/**
* Align a cut to a complete-turn boundary: if `toSeq` falls inside a turn whose
* turn/start survives the cut but whose turn/end is truncated away, the log
* would keep a dangling turn/start and later operations reject it as an open
* turn. Walk backwards from the cut and pull it up to just before the nearest
* enclosing turn/start (i.e. drop the whole unfinished turn).
* @returns the adjusted cut (never less than the first turn/start, and 0 when
*   the first turn is the one being dropped).
*/
function alignCutToTurn(events, toSeq) {
	let cut = toSeq;
	let depth = 0;
	for (let index = 0; index < cut; index++) {
		const event = events[index];
		if (event.type === "turn/start") depth++;
		else if (event.type === "turn/end") depth = Math.max(0, depth - 1);
	}
	// depth > 0 means cut sits inside an open turn: pull back to its turn/start.
	if (depth <= 0) return cut;
	for (let index = cut - 1; index >= 0; index--) {
		const event = events[index];
		if (event.type === "turn/start") return event.seq;
	}
	return 0;
}

/** First text block of a user message, flattened for the /rewind pick list. */
function userPreview(event) {
	let text = "";
	const content = event.data?.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
				text = block.text;
				break;
			}
		}
	}
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/** Rebuild the header line exactly as the JSONL backend writes it. */
function headerLine(header) {
	return `${JSON.stringify({
		type: "session",
		version: header.version,
		id: header.id,
		createdAt: header.createdAt,
		...header.cwd !== void 0 ? { cwd: header.cwd } : {},
		...header.parentSession !== void 0 ? { parentSession: header.parentSession } : {},
		...header.seedLength !== void 0 ? { seedLength: header.seedLength } : {},
		...header.origin !== void 0 ? { origin: header.origin } : {},
		delegationDepth: header.delegationDepth ?? 0,
		...header.agentPreset !== void 0 ? { agentPreset: header.agentPreset } : {}
	})}\n`;
}

/** Atomically rewrite the session's JSONL artifact from the live (truncated) log. */
async function rewriteLog(ctx, session, persistence) {
	const { path } = persistence.locate(session.header);
	if (path === void 0) throw new Error("无法定位会话日志文件");
	const compression = persistence.compression ?? "zstd";
	const packChunks = persistence.packChunks ?? true;
	const header = Buffer.from(headerLine(session.header), "utf8");
	const rows = packChunks ? packChunkRuns(session.events) : session.events;
	// An empty log writes no event bytes at all: a lone newline would decode as
	// an unparsable empty line on read, so only the header line is emitted.
	const body = Buffer.from(rows.length === 0 ? "" : `${rows.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	let content;
	if (compression === "zstd") {
		content = Buffer.concat([
			await zstdCompressAsync(header, CHECKSUM_OPTIONS),
			await zstdCompressAsync(body, CHECKSUM_OPTIONS)
		]);
	} else {
		content = Buffer.concat([header, body]);
	}
	const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await open(tmp, "wx", 0o600);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(tmp, path);
	try {
		const dirHandle = await open(dirname(path), "r");
		try {
			await dirHandle.sync();
		} finally {
			await dirHandle.close();
		}
	} catch {
		/* best-effort directory fsync (unsupported on some platforms) */
	}
}

/**
* Truncate the live session log to `toSeq` and make it durable:
* 1. drain the persistence coordinator's buffered writes,
* 2. splice the shared log array + reset every derived cache (surface, messages,
*    header/context folds, events snapshot) so all live readers see the cut,
* 3. rewrite the JSONL artifact,
* 4. reset the coordinator's per-session cursor so future appends continue
*    from the new tail,
* 5. reset the agent loop's request-header anchor — the truncation may have
*    removed the logged request/header event, so buildRequest must re-anchor
*    instead of folding a stale `requestHeaderLogged` state into an undefined
*    header (which crashes with "Cannot read properties of undefined
*    (reading 'adapterDefaults')"),
* 6. broadcast session/rewind so clients resync the transcript.
* @param agent - the live ReactLoopAgent whose per-turn state must follow the cut.
*/
async function truncateSession(ctx, agent, toSeq) {
	const session = agent.session;
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0 || typeof persistence.locate !== "function") {
		throw new Error("当前会话持久化后端不支持日志重写（需要 JSONL 后端）");
	}
	const events = session.events;
	if (hasOpenTurn(events)) {
		throw new Error("当前有未完成的回复，请等待其完成后（或取消后）再回退");
	}
	if (!Number.isSafeInteger(toSeq) || toSeq < 0 || toSeq > events.length) {
		throw new Error(`回退目标无效：${String(toSeq)}（范围 0..${events.length}）`);
	}
	// Never leave a dangling turn/start: a cut inside a turn would keep its
	// turn/start but truncate its turn/end, and the next /undo or /rewind would
	// reject the log as an open turn. Pull the cut up to the turn boundary.
	toSeq = alignCutToTurn(events, toSeq);
	if (toSeq === events.length) return { changed: false, cut: toSeq, removed: 0 };

	if (persistence.coordinator !== void 0 && typeof persistence.coordinator.flush === "function") {
		await persistence.coordinator.flush(session);
	}

	const removed = events.length - toSeq;
	const log = session.log;
	log.length = toSeq;

	session.eventsSnapshot = void 0;
	session.headerFold = void 0;
	session.headerFoldSeq = 0;
	session.contextFold = void 0;
	session.contextFoldSeq = 0;
	session.derived = [];
	session.derivedNodes = 0;
	session.derivedGeneration = 0;
	const surface = session.surfaceManager;
	surface._state = { nodes: [], replaceGeneration: 0 };
	surface._lastProcessedSeq = surface.baseSeq - 1;
	surface._pendingPlan = void 0;

	// The request/header anchor may have been truncated away: let the next
	// buildRequest log a fresh "initial" header instead of folding a stale one.
	if (typeof agent === "object" && agent !== null && "requestHeaderLogged" in agent) {
		agent.requestHeaderLogged = false;
	}

	// The log truncation does NOT invalidate other per-session in-memory
	// projections that replay the log, so two stale states would otherwise
	// survive the cut and resurface later:
	//
	// 1. The agent's live Inbox — the Host-authoritative queue. Its durable
	//    agent/inbox/spliced records for messages queued/steered into the cut
	//    region are gone from the log, but the live projection still lists
	//    them: hasPending stays true, so the next turn would claim and SEND
	//    that rolled-back content, and every reconnect (the events mux)
	//    re-pushes the stale rows to the client — the rewound conversation
	//    shows back up as a "waiting to send" queue. Clear the inbox: the
	//    canceled splices append at the new tail (persisted by rewriteLog
	//    below) and the api-proxy session/event hook broadcasts a fresh
	//    (empty) session/queue frame so open clients drop the stale rows
	//    immediately.
	// 2. The token-meter service's per-session fold (TokenMeter.states) can no
	//    longer catch up once the tail shrank (consumedEvents > events.length),
	//    so it keeps pricing the stale pre-cut surface and
	//    dsh-compaction-basic's fail-closed "surface does not match" check
	//    rejects the next compaction. Delete the session's fold so the next
	//    measure() replays the new tail from scratch.
	if (agent !== void 0 && agent !== null && typeof agent.inbox?.clear === "function") {
		agent.inbox.clear();
	}
	// Prefer a public per-session invalidation API when a future dsh adds one
	// (keeps us off private fields); fall back to deleting the WeakMap entry,
	// which makes the next measure() replay the cut log from scratch. Either
	// path leaves the meter's priced surface identical to the rebuilt
	// session.surface, so compaction's fail-closed consistency check passes.
	const meter = ctx.get("tokenMeter");
	if (meter !== void 0) {
		if (typeof meter.invalidate === "function") meter.invalidate(session);
		else if (typeof meter.states?.delete === "function") meter.states.delete(session);
	}

	await rewriteLog(ctx, session, persistence);

	const state = persistence.coordinator?.states?.get(session.id);
	if (state !== void 0) {
		// The cursor must cover the final log (which now also includes any
		// canceled inbox-splice records appended by the clear above), so future
		// appends continue from the rewritten tail.
		state.cursor = session.events.length;
		state.meta = { ...session.header };
		state.materialized = true;
		state.owner = session;
	}

	ctx.root.emit("session/rewind", session.id, toSeq);
	// Diagnostics: prove the emit actually ran and reached the api-proxy
	// forwarding listener (host bundle is loaded once at startup, so this log
	// also proves the running process carries the ctx.root.emit build).
	try {
		const { appendFileSync } = await import("node:fs");
		appendFileSync("/tmp/chat-rewind-host.log", `${new Date().toISOString()} emit session/rewind session=${session.id} toSeq=${toSeq} events=${events.length} listeners=${ctx.events?._hooks?.["session/rewind"]?.length ?? "?"}\n`);
	} catch (error) {
		/* best-effort diagnostics */
	}
	return { changed: true, cut: toSeq, removed };
}

function apply(ctx) {
	ctx.effect(() => ctx.commands.register({
		name: "undo",
		description: "回退上一轮对话",
		handler: async (invocation) => {
			if (invocation.rawInput.trim() !== "") return { kind: "error", text: USAGE_UNDO };
			const session = invocation.agent.session;
			const cut = lastUserMessageSeq(session.events);
			if (cut === void 0 || cut === 0) {
				return { kind: "error", text: "没有可回退的对话轮次（尚未产生可回退的用户消息）。" };
			}
			try {
				await truncateSession(ctx, invocation.agent, cut);
				// Deliberately no `text`: the command card then shows only its
				// generic "已完成" state instead of a loud rollback summary.
				return { kind: "success" };
			} catch (error) {
				return { kind: "error", text: `回退失败：${messageOf(error)}` };
			}
		}
	}), "chat-rewind: /undo command");

	ctx.effect(() => ctx.commands.register({
		name: "rewind",
		description: "回退到指定的对话位置",
		handler: async (invocation) => {
			const session = invocation.agent.session;
			const raw = invocation.rawInput.trim();
			if (raw === "") {
				const rows = [];
				for (let index = session.events.length - 1; index >= 0; index--) {
					const event = session.events[index];
					if (!isRealUserMessage(event)) continue;
					const stamp = new Date(event.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
					const preview = userPreview(event);
					rows.push(`seq=${event.seq} · ${stamp}${preview === "" ? "" : ` · ${preview}`}`);
				}
				rows.reverse();
				return rows.length === 0
					? { kind: "success", text: "没有可回退的对话位置。" }
					: {
						kind: "success",
						text: `可回退位置（${rows.length} 条用户消息，seq 即回退目标）：\n${rows.join("\n")}\n\n运行 /rewind <seq> 回到该消息——删除它及其之后的所有内容。`
					};
			}
			const toSeq = Number(raw);
			if (!Number.isSafeInteger(toSeq) || toSeq < 1 || toSeq > session.events.length) {
				return { kind: "error", text: `无效目标：${raw}（应为 1..${session.events.length} 的整数；运行 /rewind 查看可选位置）。` };
			}
			const cut = resolveCut(session.events, toSeq);
			try {
				await truncateSession(ctx, invocation.agent, cut);
				// Deliberately no `text`: the command card then shows only its
				// generic "已完成" state instead of a loud rollback summary.
				return { kind: "success" };
			} catch (error) {
				return { kind: "error", text: `回退失败：${messageOf(error)}` };
			}
		}
	}), "chat-rewind: /rewind command");
}

export { apply, inject, name };
