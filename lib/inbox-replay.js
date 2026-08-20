// Pure helper: fold a session log's agent/inbox/spliced records the way a
// fresh Inbox would on construction, and return the net pending messages per
// target. No dsh imports — usable standalone in tests and the host half.
//
// The live Inbox only cancels what is pending in memory, so a rewind that cuts
// a message's claim (the agent had already claimed it) but keeps its insert
// leaves that message "pending" when the durable file is replayed later — a
// ghost row that resurfaced on session resume/restart as a phantom "waiting to
// send" queue. This replay mirrors the Inbox constructor so truncateSession can
// durably cancel exactly those ghosts.
//
// @param events - the (already truncated) live session log.
// @returns per-target arrays of messages still pending after replay.
export function replayPendingInbox(events) {
	const pending = { "next-turn": [], "next-step": [] };
	for (const event of events) {
		if (event.type !== "agent/inbox/spliced") continue;
		const { target, start = 0, removedCount = 0, inserted = [] } = event.data ?? {};
		const list = pending[target];
		if (list === void 0) continue;
		const actualStart = Math.max(0, Math.min(start, list.length));
		const actualDelete = Math.max(0, Math.min(removedCount, list.length - actualStart));
		list.splice(actualStart, actualDelete, ...inserted);
	}
	return pending;
}
