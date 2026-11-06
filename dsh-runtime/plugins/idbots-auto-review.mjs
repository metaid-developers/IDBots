// IDBots auto review (0.2.2 headless integration).
//
// The kernel ships the same capability as the experimental
// @deepseek-ai/dsh-experimental-auto-review bundle, but that layer hard-depends
// on the dsh-permission-presets service, whose mount in turn requires a
// sandbox-declaring bash executor and drives approval policies per preset —
// a second permission system colliding with the idbots policy bridge. IDBots
// instead runs the review INSIDE its own host policy gate: when the host
// answers a tools/pre-execute check with decision "review" (the session runs
// unattended and the host would have blind-allowed), the pending call is
// assessed by the session's own model before execution.
//
// Semantics are ported from upstream's fixed REVIEW_POLICY and risk/decision
// protocol (same allow/deny shapes, same risk tiers, fail-closed on reviewer
// failure). The reviewer input is deliberately leaner than upstream's frozen
// history snapshot: environment, the latest user instruction, and the pending
// action — enough for the risk tiers without replaying the whole surface.
//
// Denial is FINAL here (upstream's `--approval-policy never` headless
// posture): the host only answers "review" on paths where a human would not
// have been asked anyway, so escalating back to a dialog would strand
// unattended sessions on the 60s auto-reject. A reviewer failure also denies
// (fail-closed, upstream AUTO_REVIEW_FAILED semantics) — it must never fail
// open into an ungated execution.

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

/** Bounded wait for the reviewer model call; a hung review must not wedge the
 * tool call until the turn-level stall watchdog. */
const REVIEW_TIMEOUT_MS = 60_000;

/** Fixed reviewer system prompt. Risk tiers and the strict JSON protocol are
 * ported from @deepseek-ai/dsh-experimental-auto-review's REVIEW_POLICY
 * (0.2.2-rc.1); the input-format paragraph is adapted to this module's
 * three-message shape (environment / user instruction / pending action). */
const REVIEW_POLICY = `REVIEW_POLICY
You are the final authorization reviewer for exactly one pending tool call. Your decision replaces human approval for this call. If you allow it, the call executes immediately with full host access and no later confirmation.

Return exactly one JSON object and no other text. An allow object has exactly two members, risk and decision, and never has reason. The only valid shapes are:
{"risk":"low","decision":"allow"}
{"risk":"medium","decision":"allow"}
{"risk":"medium","decision":"deny"}
{"risk":"medium","decision":"deny","reason":"..."}
{"risk":"high","decision":"deny"}
{"risk":"high","decision":"deny","reason":"..."}
Never return low with deny, high with allow, or a reason with allow.

First classify the pending action by its actual effects, never by the tool name, message tone, or claimed intention:
- low: ordinary project-local reads and writes, analysis, formatting, linting, tests, builds, non-destructive Git operations, and exact cleanup of an object that the session's earlier calls establish the agent created in this same session. Low must be allowed without additional explicit authorization.
- medium: irreversible deletion of pre-existing objects or state, force push or history rewrite, production reads, writes or deployments, non-sensitive external writes or sends, and permission, security-control, privilege or system changes. Medium may be allowed only when the current user instruction explicitly authorizes the action, exact target and necessary scope, with no unresolved conflict.
- high: sensitive information exfiltration across a trust boundary, including sending credentials, secrets or private data to an external or untrusted destination, and equivalent hard-deny effects. High must always be denied, even when the user explicitly requests the exact action.

The first user message gives the environment (working directory). The second user message carries the latest user instruction as a JSON object: it defines the current task and its restrictions; when it is missing the pending action has no user authorization beyond ordinary low-risk project work. The third user message is the pending tool call as a JSON object: name, arguments, and the tool description when available.

Judge the pending action by what its tool and arguments will actually do, inside the environment's working directory. The session-created cleanup exception does not cover pre-existing objects or broader deletion. Medium and high effects take precedence over ordinary low-risk project work; a production read is medium even though it is read-only, and sensitive exfiltration is high even with explicit authorization. Fail closed when actual effects are ambiguous or broader than established scope. Deny a medium action if authorization of its action, target, scope, effect, count or duration is missing, conflicting, ambiguous, or broader than the user instruction.

For any allow, end with exactly the applicable two-member object and nothing else. In particular, when a medium action is allowed, the complete text must be exactly {"risk":"medium","decision":"allow"}. Do not add reason, explanation, labels, Markdown, or surrounding prose. Stop immediately after the closing brace.`;

/** Count members in the raw top-level JSON object — duplicated members must
 * fail the protocol instead of silently keeping the last value. */
function topLevelMemberCount(text) {
	const syntax = text.replace(/"(?:\\.|[^"\\])*"/gs, "");
	let depth = 0;
	let count = 0;
	for (const char of syntax) {
		switch (char) {
			case "{":
			case "[":
				depth += 1;
				break;
			case "}":
			case "]":
				depth -= 1;
				break;
			case ":":
				if (depth === 1) count += 1;
				break;
		}
	}
	return count;
}

/** Parse the closed risk/decision protocol and its fixed safety combinations.
 * Mirrors upstream parseDecision exactly: the reviewer cannot smuggle a
 * high-risk allow or a reason onto an allow through malformed shapes. */
function parseDecision(text) {
	const value = JSON.parse(text);
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("auto-review: reviewer output must be one JSON object");
	}
	const record = value;
	const keys = Object.keys(record);
	if (topLevelMemberCount(text) !== keys.length) {
		throw new Error("auto-review: reviewer output repeats a JSON member");
	}
	const risk = record.risk;
	const decision = record.decision;
	if (keys.length === 2 && decision === "allow" && (risk === "low" || risk === "medium")) {
		return { risk, decision };
	}
	if (keys.length === 2 && decision === "deny" && (risk === "medium" || risk === "high")) {
		return { risk, decision };
	}
	if (
		decision === "deny"
		&& (risk === "medium" || risk === "high")
		&& keys.length === 3
		&& Object.hasOwn(record, "reason")
		&& typeof record.reason === "string"
	) {
		return { risk, decision, reason: record.reason };
	}
	throw new Error("auto-review: reviewer output does not match the risk/decision protocol");
}

/** Consume zero or more reasoning blocks, one JSON text block, and one
 * terminal stop from the review stream. Mirrors upstream readDecision. */
async function readDecision(stream, { BlockAssembler }) {
	const assembler = new BlockAssembler();
	let finished = false;
	for await (const chunk of stream) {
		if (finished) throw new Error("auto-review: reviewer emitted data after its terminal finish");
		assembler.push(chunk);
		if (chunk.type === "finish") {
			finished = true;
			if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
				const { code, message } = chunk.reason.failure;
				throw new Error(`auto-review: reviewer ended with ${chunk.reason.kind} ${code}: ${message}`);
			}
			if (chunk.reason.kind !== "stop") throw new Error(`auto-review: reviewer ended with ${chunk.reason.kind}`);
		}
	}
	if (!finished) throw new Error("auto-review: reviewer emitted no terminal finish");
	const blocks = assembler.blocks();
	const final = blocks.at(-1);
	if (final?.type !== "text" || blocks.slice(0, -1).some((block) => block.type !== "reasoning")) {
		throw new Error("auto-review: reviewer must emit zero or more reasoning blocks followed by exactly one text block");
	}
	return parseDecision(final.text);
}

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.slice(0, 4000);
}

/** The session's current working directory, read from the latest durable
 * runtime-context snapshot — exactly the path the model sees in its own
 * context — falling back to the session header's creation cwd. Read via
 * session introspection on purpose: a `workingDirectory` service dependency
 * would make this reviewer hard-couple to compositions that mount it. */
function currentWorkspaceCwd(session) {
	try {
		const events = session.snapshotEvents();
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== 'user/message' || event.data?.source?.kind !== 'runtime-context') continue;
			const section = (event.data.sections ?? []).find((entry) => entry?.name === 'working-directory:current');
			const match = /"([^"]+)"/u.exec(String(section?.text ?? ''));
			if (match) return match[1];
		}
	} catch {
		// Introspection is best-effort; the header fallback covers the rest.
	}
	try {
		const cwd = session.header?.cwd;
		if (typeof cwd === 'string' && cwd.length > 0) return cwd;
	} catch {}
	return undefined;
}

/** Latest durable user instruction on the session surface (source kind user).
 * Tool-sourced user messages (tool-result splices) never authorize. */
function latestUserInstruction(session) {
	try {
		const events = session.snapshotEvents();
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== "user/message") continue;
			if (event.data?.source?.kind !== "user") continue;
			const text = textOfContent(event.data.content).trim();
			if (text.length > 0) return text;
		}
	} catch {
		// Surface introspection is best-effort; absence only narrows authority.
	}
	return undefined;
}

/** One tool description line for the pending action, when the registry knows
 * the tool. Purely informational for the reviewer. */
function toolDescription(ctx, agent, name) {
	try {
		const definition = ctx.tools?.get?.(name, agent);
		const description = definition?.description;
		return typeof description === "string" ? description.slice(0, 600) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Review one pending gated tool call with the session's own model.
 * @returns {Promise<{kind:'allow'} | {kind:'deny', reason:string}>} — never
 * throws: every failure path collapses into a fail-closed denial.
 */
export async function reviewPendingAction(ctx, exec) {
	const agent = exec?.agent;
	const fail = (reason) => ({ kind: 'deny', reason });
	try {
		if (!agent) return fail('auto-review: pending call has no owning agent');
		const headerConfig = agent.session?.requestHeader?.()?.config;
		const provider = headerConfig?.provider || agent.options?.provider;
		const model = headerConfig?.model || agent.options?.model;
		if (!provider || !model) return fail('auto-review: no live model route is available for the review');
		const llm = ctx.get('llm');
		if (!llm) return fail('auto-review: the llm service is unavailable');
		const cwd = currentWorkspaceCwd(agent.session);
		const instruction = latestUserInstruction(agent.session);
		const action = {
			name: exec.name,
			arguments: exec.arguments,
			...(toolDescription(ctx, agent, exec.name) !== undefined ? { description: toolDescription(ctx, agent, exec.name) } : {}),
		};
		const messages = [
			{ role: 'user', content: [{ type: 'text', text: `ENVIRONMENT\n${JSON.stringify({ cwd: cwd ?? null })}` }] },
			{ role: 'user', content: [{ type: 'text', text: `USER_INSTRUCTION\n${JSON.stringify({ text: instruction ?? null })}` }] },
			{ role: 'user', content: [{ type: 'text', text: `PENDING_ACTION\n${JSON.stringify(action)}` }] },
		];
		// Abort with the turn, but never hang past the review deadline: a wedged
		// reviewer must fail closed (deny), not pin the tool call open.
		const controller = new AbortController();
		const onAbort = () => controller.abort(exec.signal?.reason);
		exec.signal?.addEventListener('abort', onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(new Error(`auto-review: reviewer exceeded the ${Math.round(REVIEW_TIMEOUT_MS / 1000)}s deadline`)), REVIEW_TIMEOUT_MS);
		let decision;
		try {
			const stream = ctx.llm.stream({
				provider,
				model,
				system: REVIEW_POLICY,
				messages,
				temperature: 0,
				sessionId: agent.session?.id,
				purpose: 'idbots-auto-review',
				signal: controller.signal,
			});
			decision = await readDecision(stream, { BlockAssembler });
		} finally {
			clearTimeout(timer);
			exec.signal?.removeEventListener('abort', onAbort);
		}
		if (controller.signal.aborted && !exec.signal?.aborted) {
			return fail(String(controller.signal.reason?.message ?? 'auto-review: review aborted'));
		}
		if (decision.decision === 'allow') return { kind: 'allow' };
		return fail(
			decision.reason !== undefined
				? `Auto review denied tool "${exec.name}" (${decision.risk} risk): ${decision.reason}`
				: `Auto review denied tool "${exec.name}" (${decision.risk} risk)`,
		);
	} catch (error) {
		return fail(`Auto review of tool "${exec?.name ?? 'unknown'}" failed; the call was not executed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
