window.__ModuleLoader__.load({
	id: "@flow2dream/dsh-msg-rewind",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// Required client services (cordis fiber inject, same style as
		// ui-permission): remote — forwarded remote events (the host pushes
		// "session/rewind" after a truncation); sessions — the session runtime
		// whose per-session conversation window owns the transcript; commandUi
		// — the popupSelect shell that hosts the /rewind picker; slots — the
		// conversation node renderer registry (we shadow the "user" cell to add
		// a hover "撤回" button).
		const inject = ["remote", "sessions", "commandUi", "slots"];

		/** First text block of a user message, flattened for the pick list. */
		function userPreview(content) {
			let text = "";
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

		/** Marker carried on the /rewind option rows so the load patch below can
		*  preselect the LAST row (the previous turn) while keeping the list in
		*  chronological (oldest-first) order. */
		const REWIND_OPTIONS = Symbol("chat-rewind.options");

		/**
		* The popupSelect shell always highlights options[0] after loading
		* (PopupSelectController.load sets active: 0). We want the /rewind picker
		* to open on the most recent user message (the previous turn), which is
		* the LAST row of the chronological list. Patch load() so rows carrying
		* the REWIND_OPTIONS marker preselect their last entry.
		* @param controllerCtor - the PopupSelectController class (exported by ui-commands).
		*/
		function patchPopupPreselect(controllerCtor) {
			if (controllerCtor === void 0 || typeof controllerCtor !== "function") return;
			const proto = controllerCtor.prototype;
			if (proto === void 0 || typeof proto.load !== "function") return;
			if (proto.load[REWIND_OPTIONS] === true) return;
			const original = proto.load;
			const patched = function(binding) {
				// Rebase the highlight to the last row when the marked options land.
				// Swap the spec's options() BEFORE the original load() calls it, so
				// the pending promise resolves through our wrapper.
				const spec = binding.spec;
				const upstream = spec.options;
				if (upstream !== void 0 && typeof upstream === "function") {
					spec.options = async (context, signal) => {
						const options = await upstream(context, signal);
						if (options !== void 0 && options.length > 0 && options[REWIND_OPTIONS] === true) {
							// load() sets active:0 in its own .then AFTER our wrapper
							// resolves; a plain microtask would run BEFORE that and be
							// overwritten. A macrotask runs after every microtask of the
							// current settlement, so the rebase lands last.
							setTimeout(() => {
								const s = this.state.getSnapshot();
								if (s.open && s.status === "ready" && s.options === options) {
									this.state.set({ ...s, active: s.options.length - 1 });
								}
							}, 0);
						}
						return options;
					};
				}
				return original.call(this, binding);
			};
			patched[REWIND_OPTIONS] = true;
			proto.load = patched;
		}

		/**
		* After a rewind resync, scroll the target session's conversation back to
		* the bottom: the truncated tail IS the rewind point, so the last visible
		* row (the user turn we rolled back to) should be in view rather than the
		* window restarting at the first turn. The scroller is the chat flow's
		* nearest [data-conversation-scroll] host; the resync rebuilds the list
		* asynchronously, so we retry on a couple of frames until a scroller with
		* content exists.
		*/
		function scrollRewoundSessionToBottom() {
			let attempts = 0;
			const tick = () => {
				const host = document.querySelector("[data-conversation-scroll]");
				if (host !== null && host.scrollHeight > host.clientHeight) {
					host.scrollTop = host.scrollHeight;
					return;
				}
				if (++attempts < 8) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		}

		/** Inline undo/rewind glyph (16x16, stroke-based, theme-colored). */
		function rewindGlyph() {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "16");
			svg.setAttribute("height", "16");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("fill", "none");
			svg.setAttribute("aria-hidden", "true");
			const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
			p1.setAttribute("d", "M7 3 3.5 6.5 7 10");
			p1.setAttribute("stroke", "currentColor");
			p1.setAttribute("stroke-width", "1.5");
			p1.setAttribute("stroke-linecap", "round");
			p1.setAttribute("stroke-linejoin", "round");
			const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
			p2.setAttribute("d", "M4.2 6.5H9.5a3 3 0 0 1 3 3V13");
			p2.setAttribute("stroke", "currentColor");
			p2.setAttribute("stroke-width", "1.5");
			p2.setAttribute("stroke-linecap", "round");
			svg.append(p1, p2);
			return svg;
		}

		/**
		* DOM enhancement: append a hover-only "撤回" (undo) icon button into each
		* USER bubble's action row. The OFFICIAL user renderer stays untouched, so
		* the bubble color, hover time, and copy button all behave as before. The
		* button lives inside the official [data-time-hover-root] row, so it is
		* revealed by the same hover rule. A MutationObserver re-scans as the
		* conversation re-renders (resync, new turns, pagination).
		* @param ctx - client root context.
		* @param sessions - sessions service (resolve the live session for /rewind).
		*/
		function installRewindButtons(ctx, sessions) {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
			const BUTTON_ATTR = "data-chat-rewind-btn";
			const processUserNode = (flowItem) => {
				if (flowItem.querySelector(`[${BUTTON_ATTR}]`) !== null) return;
				const kind = flowItem.getAttribute("data-chat-flow-kind");
				if (kind !== "user") return;
				// The official actions row is the LAST child of the
				// [data-time-hover-root] row; it already holds time + copy button.
				const root = flowItem.querySelector("[data-time-hover-root]");
				if (root === null) return;
				const actions = root.lastElementChild;
				if (actions === null || actions.tagName !== "DIV") return;
				const seq = Number(flowItem.getAttribute("data-chat-user-seq") ?? "0");
				const button = document.createElement("button");
				button.type = "button";
				button.setAttribute(BUTTON_ATTR, "");
				button.setAttribute("title", seq > 0 ? `撤回这条消息（回退到它之前）` : "撤回");
				button.style.cssText = [
					"width:28px;height:28px;color:var(--dsw-alias-label-tertiary, #888)",
					"cursor:pointer;background:transparent;border:none;border-radius:28px",
					"display:inline-flex;align-items:center;justify-content:center;padding:6px;flex:none"
				].join(";");
				button.addEventListener("mouseenter", () => {
					button.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06))";
					button.style.color = "var(--dsw-alias-label-secondary, #555)";
				});
				button.addEventListener("mouseleave", () => {
					button.style.background = "transparent";
					button.style.color = "var(--dsw-alias-label-tertiary, #888)";
				});
				button.append(rewindGlyph());
				button.addEventListener("click", () => {
					if (seq <= 0) return;
					let sessionId;
					try {
						sessionId = sessions?.list?.getSnapshot?.().current;
					} catch (error) {
						sessionId = void 0;
					}
					const live = sessionId !== void 0 ? sessions.binding(sessionId)?.session : void 0;
					if (live === void 0) return;
					live.command(`/rewind ${String(seq)}`).catch((error) => {
						console.error(`[chat-rewind] visual rewind failed at seq ${String(seq)}:`, error);
					});
				});
				actions.appendChild(button);
			};
			const scan = () => {
				for (const item of document.querySelectorAll("[data-chat-flow-kind=\"user\"]")) processUserNode(item);
				hideRewindCommandRows(sessions);
			};
			// Stamp the user seq onto the flow item so the injected button knows the
			// target; the conversation node data is not on the DOM, so the seq is
			// looked up via the session snapshot keyed by the anchor key.
			const stampSeqs = () => {
				for (const item of document.querySelectorAll("[data-chat-flow-kind=\"user\"]")) {
					if (item.hasAttribute("data-chat-user-seq")) continue;
					const key = item.getAttribute("data-chat-anchor-key");
					if (key === null) continue;
					const seq = userSeqForKey(sessions, key);
					if (seq !== void 0) item.setAttribute("data-chat-user-seq", String(seq));
				}
			};
			stampSeqs();
			scan();
			const observer = new MutationObserver(() => {
				stampSeqs();
				scan();
			});
			observer.observe(document.body, { childList: true, subtree: true });
			ctx.effect(() => () => observer.disconnect(), "chat-rewind: rewind button observer");
		}

		/**
		* Hide the command rows /rewind and /undo produce ("命令 已完成" cards).
		* The visual /rewind button already provides the affordance, so the
		* lifecycle card is redundant noise.
		*
		* Previous versions resolved the command name from the session snapshot,
		* but the snapshot node structure varies across DSH versions (some store
		* the raw data object, others wrap it with {kind, data}). Instead we
		* match the card's text content against known rewind/undo identifiers,
		* which is version-agnostic.
		* @param sessions - sessions service (unused now, kept for API compat).
		*/
		function hideRewindCommandRows(sessions) {
			for (const item of document.querySelectorAll("[data-chat-flow-kind=\"command\"]")) {
				if (item.hasAttribute("data-chat-rewind-hidden")) continue;
				const name = commandNameForKey(sessions, item.getAttribute("data-chat-anchor-key"));
				if (name !== "rewind" && name !== "undo") {
					// Fallback: match by card text content (version-agnostic).
					// The card title is the command name; check the first 60 chars
					// to avoid matching unrelated output text containing these words.
					const text = (item.textContent ?? "").toLowerCase().slice(0, 60);
					if (!text.includes("rewind") && !text.includes("undo")) continue;
				}
				item.setAttribute("data-chat-rewind-hidden", "");
				item.style.display = "none";
			}
		}

		/**
		* Resolve a command node's name from the conversation snapshot by anchor key.
		* The snapshot node structure varies across DSH versions:
		*   - rc.6 and earlier: { kind: "command", data: { name: "rewind", ... } }
		*   - rc.8+:            { name: "rewind", outcome: { ... }, ... }  (flat)
		* Try both shapes; return undefined when neither matches.
		* @returns the command name (e.g. "rewind", "undo"), or undefined.
		*/
		function commandNameForKey(sessions, key) {
			try {
				const current = sessions?.list?.getSnapshot?.().current;
				const live = current !== void 0 ? sessions.binding(current)?.session : void 0;
				const snap = live?.getSnapshot?.();
				const node = snap?.chat?.nodes?.get?.(key);
				if (node === void 0) return void 0;
				// rc.8+ flat shape: { name: "rewind", outcome: ... }
				if (typeof node.name === "string") return node.name;
				// rc.6 nested shape: { kind: "command", data: { name: "rewind" } }
				if (typeof node.data?.name === "string") return node.data.name;
			} catch (error) {
				/* best-effort */
			}
			return void 0;
		}

		/**
		* Resolve a user node's seq from the conversation snapshot by its anchor
		* key. Falls back to scanning the snapshot's user nodes for a matching key.
		* @returns the user message seq, or undefined.
		*/
		function userSeqForKey(sessions, key) {
			try {
				const current = sessions?.list?.getSnapshot?.().current;
				const live = current !== void 0 ? sessions.binding(current)?.session : void 0;
				const snap = live?.getSnapshot?.();
				const nodes = snap?.chat?.nodes;
				const node = nodes?.get?.(key);
				if (node !== void 0 && node?.kind === "user" && Number.isSafeInteger(node?.data?.seq)) return node.data.seq;
				// Fallback: match by key across legacy nodes.
				const legacy = snap?.chat?.legacy?.nodes ?? [];
				for (const n of legacy) {
					if (n?.key === key && n?.kind === "user" && Number.isSafeInteger(n?.data?.seq)) return n.data.seq;
				}
			} catch (error) {
				/* best-effort */
			}
			return void 0;
		}

		/**
		* Client half:
		* 1. On a host-pushed session/rewind event, rebuild the target session's
		*    conversation window from the host (same path a reconnect uses), so
		*    the truncated transcript replaces the stale one in place.
		* 2. Decorate the host /rewind command with a popupSelect picker: bare
		*    invocation opens a dialog listing the recent user messages (seq +
		*    preview + time); picking one submits `/rewind <seq>` back through
		*    the session's command verb.
		* 3. Add a hover-only "撤回" button to each USER bubble (visual /rewind)
		*    via DOM enhancement — the official bubble renderer stays untouched.
		* @param ctx - client Cordis root context.
		*/
		function apply(ctx) {
			const sessions = ctx.sessions;
			const sessionFor = (id) => sessions.binding(id)?.session;

			// Preselect the LAST /rewind option (previous turn) on popup open while
			// keeping the list chronological. ui-commands exports the controller
			// class, so we can patch its prototype load() safely.
			try {
				const uiCommands = require("@deepseek-ai/dsh-client-ui-commands");
				patchPopupPreselect(uiCommands?.PopupSelectController);
			} catch (error) {
				console.warn("[chat-rewind] popup preselect patch failed:", error);
			}

			// #region session/rewind listener — registered FIRST and independently so a
			// failure in the /rewind popup decoration below can never roll it back.
			ctx.effect(() => ctx.remote.$on("session/rewind", (sessionId) => {
				console.log(`[chat-rewind] session/rewind event received for session ${String(sessionId)}`);
				// Prefer a precise resync of the target session: rebuild just its
				// window. Fall back to handleConnected (full refresh) when the
				// per-session path is unavailable.
				const bound = sessionFor(sessionId);
				if (bound !== void 0) {
					bound.resync().catch((error) => {
						console.error(`[chat-rewind] resync failed for session ${String(sessionId)}:`, error);
					});
					scrollRewoundSessionToBottom();
					return;
				}
				if (typeof sessions.handleConnected === "function") {
					try {
						sessions.handleConnected();
					} catch (error) {
						console.error(`[chat-rewind] sessions.handleConnected() failed for session ${String(sessionId)}:`, error);
					}
					scrollRewoundSessionToBottom();
					return;
				}
				if (sessions.manager === void 0) return;
				const record = sessions.manager.sessions?.get(sessionId);
				if (record === void 0) return;
				record.resync().catch((error) => {
					console.error(`[chat-rewind] resync failed for session ${String(sessionId)}:`, error);
				});
				scrollRewoundSessionToBottom();
			}), "chat-rewind: session/rewind listener");
			// #endregion

			// #region /rewind popup decoration — isolated so its failure (e.g. the
			// host command directory not yet synced) cannot break the listener above.
			const command = ctx.get("commandUi");
			if (command === void 0 || typeof command.decorate !== "function") {
				console.warn("[chat-rewind] commandUi unavailable; /rewind popup decoration skipped");
				return;
			}
			ctx.effect(() => {
				try {
					return command.decorate({
						name: "rewind",
						available: () => true,
						ui: {
							kind: "popupSelect",
							options: async (session, signal) => {
								const live = sessionFor(session.sessionId);
								// Pull the FULL history from the host (paginated) instead
								// of the local window snapshot, so the FIRST user turn is
								// reachable even in long sessions. history() pages are
								// chronological within a page; pages walk newest→oldest, so
								// each later page is PREPENDED (older content comes first).
								const pages = [];
								let beforeSeq = void 0;
								let exhausted = false;
								let page = 0;
								while (!exhausted && page < 200) {
									if (signal.aborted) return [];
									let history;
									try {
										history = await live.history({
											...beforeSeq === void 0 ? {} : { beforeSeq },
											maxMessages: 100
										});
									} catch (error) {
										console.error("[chat-rewind] history fetch failed:", error);
										break;
									}
									// history() resolves to { result: { ok, value: { events, hasMore } } }
									const result = history?.result;
									if (result === void 0 || !result.ok || result.value === void 0) break;
									const events = result.value.events ?? [];
									if (events.length === 0) break;
									pages.unshift(events);
									exhausted = result.value.hasMore !== true;
									const oldest = events[0]?.event;
									if (oldest === void 0 || oldest.seq === 0) exhausted = true;
									else beforeSeq = oldest.seq;
									page++;
								}
								const rows = [];
								for (const entries of pages) {
									for (const entry of entries) {
										if (signal.aborted) return [];
										const event = entry?.event;
										if (event === void 0 || event.type !== "user/message" || event.surfaceOp !== "append") continue;
										// Only real user-authored messages are rewind targets;
										// system injections have source.kind !== "user".
										if (event.data?.source?.kind !== "user") continue;
										const stamp = new Date(event.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
										const preview = userPreview(event.data?.content);
										rows.push({
											id: String(event.seq),
											label: preview === "" ? "(空消息)" : preview,
											detail: `seq=${event.seq} · ${stamp}`,
											confirmation: {
												title: "回退到该位置？",
												description: `将删除 seq ${event.seq} 及其之后的所有记录，且不可恢复。`,
												acknowledgeLabel: "了解",
												cancelLabel: "取消",
												confirmLabel: "确认回退"
											}
										});
									}
								}
								// Chronological (oldest-first) order; the load() patch
								// preselects the LAST row (previous turn) via marker.
								rows[REWIND_OPTIONS] = true;
								return rows;
							},
							onSelect: async (option, session) => {
								const live = sessionFor(session.sessionId);
								if (live === void 0) throw new Error("this session is not materialized yet");
								const result = await live.command(`/rewind ${option.id}`);
								if (!result.ok) throw new Error(`rewind failed: ${result.error.code}: ${result.error.message}`);
								if (!result.value.matched) throw new Error("the host offers no /rewind command");
							}
						}
					});
				} catch (error) {
					console.error("[chat-rewind] /rewind popup decoration failed:", error);
					return () => {};
				}
			}, "chat-rewind: /rewind popup decoration");
			// #endregion

			// #region hover "撤回" button on USER bubbles (visual /rewind) — DOM
			// enhancement: keep the OFFICIAL user bubble renderer untouched (bubble
			// color, hover time, copy button all stay intact) and instead append a
			// small undo-glyph button into each user node's action row. The official
			// row lives inside [data-time-hover-root], so our button inherits the
			// hover-reveal behavior for free.
			try {
				installRewindButtons(ctx, sessions);
			} catch (error) {
				console.warn("[chat-rewind] user rewind button install failed:", error);
			}
			// #endregion
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
