import { resolveDshHome, dshHomeDisplay } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import {
	CallId,
	CONTEXT_WINDOW_EXCEEDED_CODE,
	EMPTY_RESPONSE_CODE,
	LlmAdapter,
	LlmError,
	ProviderRequestId,
	QUOTA_EXCEEDED_CODE,
	ReasoningEffortId,
	RetryPolicySchema,
	assertUsableApiKey,
	attributionHeaders,
	contentHasImage,
	isContextWindowExceededError,
	isQuotaExceededError,
	resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import { EventSourceParserStream } from "eventsource-parser/stream";

//#region constants
/**
 * GitHub Copilot authentication and edge constants.
 *
 * The client id and editor identity headers are the ones the VS Code Copilot
 * Chat extension sends; Copilot's edge gates chat completions on them. The
 * OAuth device-flow scope is `read:user` (the only thing the completions API
 * path needs). See `@deepseek-ai/dsh-llm-copilot` README for the full flow.
 */
const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_COPILOT_SCOPE = "read:user";
const GITHUB_COPILOT_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_COPILOT_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_COPILOT_API_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";
const COPILOT_CHAT_URL = "https://api.githubcopilot.com/chat/completions";
const GITHUB_COPILOT_USER_AGENT = "GithubCopilot/1.155.0";
const COPILOT_EDITOR_VERSION = "vscode/1.95.0";
const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.22.4";
const COPILOT_INTEGRATION_ID = "vscode-chat";

/** Refresh a cached Copilot session token this many seconds before it expires. */
const TOKEN_REFRESH_BUFFER_SECS = 300;
/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Default combined request/response context capacity for Copilot chat models. */
const DEFAULT_CONTEXT_WINDOW = 200000;
/** Default per-request output-token cap. */
const DEFAULT_MAX_TOKENS = 16384;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const OFF_REASONING_EFFORT = ReasoningEffortId("off");
const REASONING_EFFORT_NAMES = {
	off: "Off",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max"
};
/**
 * Map one Copilot `/models` `reasoning_effort` level (or a configured catalog
 * level) to the harness reasoning-effort id. Copilot spells reasoning disabled
 * as `none`, which folds into the harness `off`; Gemini's `minimal` has no
 * harness level and is dropped (selecting `off` simply omits the parameter);
 * unknown levels are dropped rather than surfaced.
 */
function reasoningEffortId(raw) {
	switch (raw) {
		case "none": case "off": return OFF_REASONING_EFFORT;
		case "minimal": return void 0;
		case "low": case "medium": case "high": case "xhigh": case "max": return ReasoningEffortId(raw);
		default: return void 0;
	}
}
/**
 * The harness reasoning efforts one model may offer, from its /models
 * `reasoning_effort` list or an explicit catalog override. `off` is always
 * offered — it maps to omitting the parameter on chat and `none` on responses
 * — and a model that lists no levels at all is text-only and stays `off`.
 */
function modelReasoningEfforts(levels) {
	const seen = /* @__PURE__ */ new Set();
	const efforts = [];
	for (const level of levels ?? []) {
		const id = reasoningEffortId(level);
		if (id === void 0 || seen.has(id)) continue;
		seen.add(id);
		efforts.push({ id, name: REASONING_EFFORT_NAMES[id] ?? id });
	}
	if (!seen.has(OFF_REASONING_EFFORT)) efforts.unshift({ id: OFF_REASONING_EFFORT, name: REASONING_EFFORT_NAMES.off });
	return efforts;
}
/** The selector's default effort for one model: medium when offered, else off. */
function defaultReasoningEffort(levels) {
	const efforts = modelReasoningEfforts(levels);
	for (const id of ["medium", "low", "high", "off"]) if (efforts.some((effort) => effort.id === id)) return id;
	return efforts[0]?.id ?? OFF_REASONING_EFFORT;
}

/** The single provider route this plugin owns. */
const PROVIDER = "copilot-oauth";
/** Default credentials.yaml reference that holds the long-lived GitHub OAuth token. */
const DEFAULT_API_KEY_ENV = "GITHUB_COPILOT_TOKEN";
/** Namespace this plugin's settings section lives under, written by the web Models page. */
const NS = settingsNamespace("llm-copilot");
//#endregion

//#region lib/types/auth.js
/**
 * GitHub Copilot two-tier authentication: a long-lived GitHub OAuth access
 * token (obtained once through the OAuth device flow, then held in the harness
 * credential seam like any other provider key) is exchanged on demand for a
 * short-lived Copilot API session token, which is what the chat-completions
 * edge actually accepts as a bearer credential.
 *
 * The exchange result is cached in memory and refreshed proactively (with a
 * five-minute safety buffer) so the only per-request cost is a header check. A
 * 401 from the edge invalidates the cache so the next call re-exchanges.
 *
 * @module @deepeak-ai/dsh-llm-copilot/auth
 */
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try { inner.call(this); } catch (e) { return Promise.reject(e); }
		};
		env.stack.push({ value, dispose, async });
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
}(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});

/** Headers Copilot's edge requires on every authenticated call. */
function copilotEdgeHeaders() {
	return {
		"user-agent": GITHUB_COPILOT_USER_AGENT,
		"editor-version": COPILOT_EDITOR_VERSION,
		"editor-plugin-version": COPILOT_EDITOR_PLUGIN_VERSION,
		"copilot-integration-id": COPILOT_INTEGRATION_ID
	};
}

/**
 * Exchange a GitHub OAuth access token for a Copilot API session token.
 *
 * `GET https://api.github.com/copilot_internal/v2/token` with
 * `Authorization: token <oauth>` (the non-standard `token` scheme Copilot
 * expects, not `Bearer`). Returns the session token plus its expiry as a Unix
 * epoch in seconds.
 */
async function exchangeCopilotToken(oauthToken, signal) {
	const url = GITHUB_COPILOT_API_TOKEN_URL;
	let response;
	try {
		const headers = {
			...copilotEdgeHeaders(),
			accept: "application/json",
			authorization: `token ${oauthToken}`
		};
		const init = { method: "GET", headers, signal };
		response = await fetch(url, init);
	} catch (error) {
		if (signal?.aborted) throw new LlmError("Copilot token exchange aborted by caller", "ABORTED", { cause: error });
		throw new LlmError(`Copilot token exchange to ${url} failed`, "TRANSPORT", { cause: error });
	}
	if (!response.ok) {
		const body = await safeText(response);
		throw new LlmError(`Copilot token exchange failed (HTTP ${response.status}): ${truncate(body, 256)}`, tokenExchangeErrorCode(response.status), { status: response.status });
	}
	let payload;
	try {
		payload = await response.json();
	} catch (error) {
		throw new LlmError(`Copilot token exchange returned non-JSON: ${truncate(await safeText(response), 256)}`, "MALFORMED_RESPONSE", { cause: error });
	}
	const token = payload?.token;
	const expiresAt = payload?.expires_at;
	if (typeof token !== "string" || token.length === 0) throw new LlmError("Copilot token exchange did not return a session token", "INVALID_CREDENTIAL");
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new LlmError("Copilot token exchange did not return a numeric expires_at", "INVALID_CREDENTIAL");
	return { token, expiresAt };
}

/** Map a token-exchange HTTP failure to a harness code. */
function tokenExchangeErrorCode(status) {
	if (status === 401 || status === 403) return "AUTH";
	if (status === 429) return "RATE_LIMIT";
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}

/** Read a response body without throwing on absent bodies or cancellation. */
async function safeText(response) {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

/** Truncate a string for diagnostics, never echoing a full secret. */
function truncate(value, max) {
	return typeof value === "string" && value.length > max ? `${value.slice(0, max)}…` : String(value ?? "");
}

/** Unix epoch seconds at the current instant. */
function unixNow() {
	return Math.floor(Date.now() / 1000);
}

/**
 * Caches one Copilot session token, refreshing it before expiry. A caller
 * supplies its long-lived GitHub OAuth token once; the manager owns the
 * short-lived session credential and never persists it — it lives only in the
 * running host process.
 */
class CopilotTokenManager {
	/**
	 * @param oauthToken - the long-lived GitHub OAuth access token.
	 * @param logger - Cordis logger for refresh diagnostics.
	 */
	constructor(oauthToken, logger) {
		this.oauthToken = oauthToken;
		this.logger = logger;
		this.cached = null;
		this.inflight = null;
	}
	/** True when the cached token has at least the refresh buffer left to live. */
	isFresh(cached) {
		return cached !== null && cached.expiresAt > unixNow() + TOKEN_REFRESH_BUFFER_SECS;
	}
	/** The current valid session token, refreshing if needed. */
	async getToken(signal) {
		if (this.isFresh(this.cached)) return this.cached.token;
		if (this.inflight) {
			try {
				return (await this.inflight).token;
			} catch (error) {
				if (this.cached !== null && this.isFresh(this.cached)) return this.cached.token;
				throw error;
			}
		}
		const refresh = (async () => {
			const exchanged = await exchangeCopilotToken(this.oauthToken, signal);
			this.cached = { token: exchanged.token, expiresAt: exchanged.expiresAt };
			this.logger.debug(`Copilot session token refreshed; expires in ${exchanged.expiresAt - unixNow()}s`);
			return this.cached;
		})();
		this.inflight = refresh;
		try {
			return (await refresh).token;
		} finally {
			this.inflight = null;
		}
	}
	/** Drop the cache so the next call re-exchanges; called on 401 from the edge. */
	invalidate() {
		this.cached = null;
		this.inflight = null;
		this.logger.debug("Copilot session token invalidated");
	}
}
//#endregion

//#region lib/types/serialize.js
/**
 * Serialize harness messages into Copilot (OpenAI-compatible) chat messages.
 * Copilot does not accept images in this adapter's request path — reject
 * explicitly rather than silently dropping bytes — and flattens text blocks the
 * way the DeepSeek adapter does.
 *
 * @module @deepseek-ai/dsh-llm-copilot/serialize
 */
/** Assert no image content before a text-flattening path can silently erase it. */
function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The GitHub Copilot adapter does not support image content.", "UNSUPPORTED_CONTENT");
}
/** Join the text blocks of a message. */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/**
 * The harness suffixes the provider-issued call id with its own correlation
 * hash (`call_xxx|fc_yyy`), which can exceed Copilot's 64-char cap on
 * `call_id`. Recover the real server id when possible; otherwise truncate
 * deterministically so a call keeps one stable id across its `function_call`
 * and `function_call_output` items (and chat `tool_calls`/`tool` messages).
 */
function sanitizeCallId(id) {
	if (typeof id !== "string" || id.length <= 64) return id;
	const bare = id.split("|")[0];
	if (bare.length > 0 && bare.length <= 64) return bare;
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
	return `${id.slice(0, 50)}-${(hash >>> 0).toString(36)}`;
}
/** Serialize one assistant message (text + tool calls) into a wire message. */
function serializeAssistant(message) {
	const text = flattenText(message.content);
	const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
		id: sanitizeCallId(block.id),
		type: "function",
		function: { name: block.name, arguments: block.arguments }
	}));
	return {
		role: "assistant",
		content: text,
		...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
	};
}
/**
 * Serialize the conversation into Copilot wire messages. `tool-result` blocks
 * become standalone `{role: 'tool'}` messages; the harness puts each tool
 * result in its own user-role message, so a mixed user message contributes its
 * text first, then its tool results as separate wire messages after.
 */
function serializeMessages(messages) {
	const wire = [];
	for (const message of messages) {
		assertTextOnly(message.content);
		if (message.role === "system") {
			wire.push({ role: "system", content: flattenText(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			wire.push(serializeAssistant(message));
			continue;
		}
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const text = flattenText(message.content);
		if (text.length > 0 || toolResults.length === 0) wire.push({ role: "user", content: text });
		for (const result of toolResults) wire.push({
			role: "tool",
			tool_call_id: sanitizeCallId(result.toolCallId),
			content: flattenText(result.content) || "(no output)"
		});
	}
	return wire;
}
/**
 * Build the full Copilot chat-completions request body. Always streaming
 * (`stream: true`, usage reporting on); optional fields are omitted rather than
 * sent as null, so provider defaults apply.
 */
function serializeRequest(options, defaults) {
	const messages = [];
	if (options.system !== void 0) messages.push({ role: "system", content: options.system });
	messages.push(...serializeMessages(options.messages));
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters }
	}));
	return {
		model: options.model,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		...options.reasoningEffort !== void 0 && options.reasoningEffort !== OFF_REASONING_EFFORT ? { reasoning_effort: options.reasoningEffort } : {},
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
		...options.stop !== void 0 ? { stop: options.stop } : {}
	};
}
/** Serialize one harness message into a `/responses` input item. */
function serializeResponsesMessage(message) {
	assertTextOnly(message.content);
	if (message.role === "system") return { role: "system", content: flattenText(message.content) };
	if (message.role === "assistant") {
		const text = flattenText(message.content);
		const calls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
			type: "function_call",
			call_id: sanitizeCallId(block.id),
			name: block.name,
			arguments: block.arguments ?? "{}"
		}));
		return [
			...(text.length > 0 ? [{ role: "assistant", content: text }] : []),
			...calls
		];
	}
	const text = flattenText(message.content);
	const results = message.content.filter((block) => block.type === "tool-result").map((block) => ({
		type: "function_call_output",
		call_id: sanitizeCallId(block.toolCallId),
		output: flattenText(block.content) || "(no output)"
	}));
	return [
		...(text.length > 0 || results.length === 0 ? [{ role: "user", content: text }] : []),
		...results
	];
}
/**
 * Build the Copilot `/responses` request body for models that only serve that
 * endpoint (the gpt-5.x family). Reasoning disabled is sent explicitly as
 * `none`; every other effort passes through as the wire `reasoning.effort`.
 * A `detailed` reasoning summary is requested whenever reasoning is enabled:
 * without it the edge streams no `reasoning_summary_text` at all (the full
 * chain-of-thought is BYOK-encrypted on this subscription, but the summary is
 * readable), so the harness would show no thinking blocks.
 */
function serializeResponsesRequest(options, defaults) {
	const input = [];
	if (options.system !== void 0) input.push({ role: "system", content: options.system });
	for (const message of options.messages) input.push(...[serializeResponsesMessage(message)].flat());
	const tools = options.tools?.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	const reasoning = options.reasoningEffort === void 0 ? void 0 : {
		effort: options.reasoningEffort === OFF_REASONING_EFFORT ? "none" : options.reasoningEffort,
		...options.reasoningEffort === OFF_REASONING_EFFORT ? {} : { summary: "detailed" }
	};
	return {
		model: options.model,
		input,
		stream: true,
		...reasoning === void 0 ? {} : { reasoning },
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.maxTokens === void 0 ? {} : { max_output_tokens: options.maxTokens },
		...options.stop !== void 0 ? { stop: options.stop } : {}
	};
}
function providerRetryAfterMs(value) {
	if (value == null) return void 0;
	if (/^\d+$/.test(value)) {
		const delay = Number(value) * 1e3;
		return Number.isFinite(delay) && delay > 0 ? delay : void 0;
	}
	const delay = Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}
function requestId(headers) {
	const value = headers.get("x-request-id") ?? headers.get("x-deepseek-request-id");
	return value == null || value.length === 0 ? void 0 : ProviderRequestId(value);
}
/** Map an HTTP status to a stable LlmError code. */
function httpErrorCode(status, error) {
	if (status === 401 || status === 403) return "AUTH";
	const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
	if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) return "INVALID_REQUEST";
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
/** Parse one SSE byte stream into data payloads, `[DONE]`-terminated. */
async function* parseSse(stream, onComment) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
	for await (const { data } of events) {
		yield data;
		if (data === "[DONE]") return;
	}
	throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion

//#region lib/types/translate.js
/**
 * Translate Copilot (OpenAI-compatible) SSE payloads into harness StreamChunks,
 * one stateful block per content, reasoning, or tool-call index. Finish reason
 * and usage are deferred until `[DONE]`.
 *
 * @module @deepseek-ai/dsh-llm-copilot/translate
 */
const CONTEXT_WINDOW_EXCEEDED = "CONTEXT_WINDOW_EXCEEDED";
/** Map wire finish_reason to the harness FinishReason. */
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		case "content_filter": return {
			kind: "error",
			failure: { message: "model stopped: content_filter", code: "CONTENT_FILTER" }
		};
		default: return {
			kind: "error",
			failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() }
		};
	}
}
/** Map wire usage fields to the harness disjoint-token convention. */
function mapUsage(usage) {
	const cacheRead = usage.prompt_tokens_details?.cached_tokens;
	return {
		inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
		outputTokens: usage.completion_tokens,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {}
	};
}
function closeBlock(block) {
	switch (block.kind) {
		case "text": return { type: "text", text: block.text };
		case "reasoning": return { type: "reasoning", text: block.text };
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
 * Consume SSE data payloads (`[DONE]`-terminated) and yield StreamChunks.
 * Malformed JSON payloads abort with `MALFORMED_RESPONSE`. No chunk follows
 * `finish`; usage always precedes it.
 */
async function* translate(payloads) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	function open(kind) {
		const block = { index: nextIndex++, kind, text: "" };
		order.push(block);
		return block;
	}
	for await (const payload of payloads) {
		if (payload === "[DONE]") {
			for (const block of order) yield {
				type: "block-end",
				index: block.index,
				block: closeBlock(block)
			};
			if (pendingUsage) yield { type: "usage", usage: pendingUsage };
			const reason = pendingFinish ?? { kind: "stop" };
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? {
					kind: "error",
					failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE }
				} : reason
			};
			return;
		}
		let chunk;
		try {
			chunk = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${truncate(payload, 120)}`, "MALFORMED_RESPONSE");
		}
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			const reasoning = delta?.reasoning_content;
			if (typeof reasoning === "string" && reasoning.length > 0) {
				if (!reasoningBlock) {
					reasoningBlock = open("reasoning");
					yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
				}
				reasoningBlock.text += reasoning;
				yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
			}
			const content = delta?.content;
			if (typeof content === "string" && content.length > 0) {
				if (!textBlock) {
					textBlock = open("text");
					yield { type: "block-start", index: textBlock.index, blockType: "text" };
				}
				textBlock.text += content;
				yield { type: "text-delta", index: textBlock.index, text: content };
			}
			for (const call of delta?.tool_calls ?? []) {
				let block = toolBlocks.get(call.index);
				if (!block) {
					block = open("tool-call");
					toolBlocks.set(call.index, block);
					yield { type: "block-start", index: block.index, blockType: "tool-call" };
				}
				if (call.id !== void 0) block.callId = call.id;
				if (call.function?.name !== void 0) block.name = block.name ?? call.function.name;
				const fragment = call.function?.arguments ?? "";
				block.text += fragment;
				yield { type: "tool-call-delta", index: block.index, id: CallId(block.callId ?? ""), ...block.name !== void 0 && block.name.length > 0 ? { name: block.name } : {}, argumentsDelta: fragment };
			}
			if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
		}
		if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
	}
	throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}
/** Map `/responses` usage to the harness disjoint-token convention. */
function mapResponsesUsage(usage) {
	const cacheRead = usage.input_tokens_details?.cached_tokens;
	return {
		inputTokens: usage.input_tokens - (cacheRead ?? 0),
		outputTokens: usage.output_tokens,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {}
	};
}
/**
 * Consume Copilot `/responses` SSE events into harness StreamChunks. Unlike
 * chat-completions, the stream ends with `response.completed` (or
 * `response.failed`) rather than a `[DONE]` sentinel; text arrives through
 * `response.output_text.delta`, tool calls through `output_item.added` plus
 * `function_call_arguments.*`, and the final item list on `completed` decides
 * the finish reason. Reasoning summaries on this subscription arrive encrypted
 * (`client_byok`) — but the requested `reasoning.summary` (detailed) streams
 * as readable text, so the thinking block shows the summary; the effort is
 * still honored server-side and reasoning tokens appear in usage.
 */
async function* translateResponses(payloads) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map(); // by call id
	let currentToolCall;
	const order = [];
	let pendingUsage;
	function open(kind) {
		const block = { index: nextIndex++, kind, text: "" };
		order.push(block);
		return block;
	}
	function* finish(reason) {
		for (const block of order) yield {
			type: "block-end",
			index: block.index,
			block: closeBlock(block)
		};
		if (pendingUsage) yield { type: "usage", usage: pendingUsage };
		yield {
			type: "finish",
			reason: reason.kind === "stop" && order.length === 0 ? {
				kind: "error",
				failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE }
			} : reason
		};
	}
	for await (const payload of payloads) {
		if (payload === "[DONE]") return;
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${truncate(payload, 120)}`, "MALFORMED_RESPONSE");
		}
		switch (event.type) {
			case "response.output_text.delta": {
				const delta = event.delta;
				if (typeof delta !== "string" || delta.length === 0) break;
				if (!textBlock) {
					textBlock = open("text");
					yield { type: "block-start", index: textBlock.index, blockType: "text" };
				}
				textBlock.text += delta;
				yield { type: "text-delta", index: textBlock.index, text: delta };
				break;
			}
			case "response.reasoning_summary_text.delta": {
				const delta = event.delta;
				if (typeof delta !== "string" || delta.length === 0) break;
				if (!reasoningBlock) {
					reasoningBlock = open("reasoning");
					yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
				}
				reasoningBlock.text += delta;
				yield { type: "reasoning-delta", index: reasoningBlock.index, text: delta };
				break;
			}
			case "response.output_item.added": {
				const item = event.item;
				if (item?.type !== "function_call" || typeof item.call_id !== "string") break;
				if (toolBlocks.has(item.call_id)) break;
				const block = open("tool-call");
				block.callId = item.call_id;
				block.name = item.name;
				toolBlocks.set(item.call_id, block);
				currentToolCall = block;
				yield { type: "block-start", index: block.index, blockType: "tool-call" };
				break;
			}
			case "response.function_call_arguments.delta": {
				// The event's item_id is opaque (encrypted on this subscription), so
				// fragments attach to the in-flight call; the completed response
				// reconciles final values authoritatively.
				const block = currentToolCall;
				if (block === void 0 || typeof event.delta !== "string") break;
				block.text += event.delta;
				yield { type: "tool-call-delta", index: block.index, id: CallId(block.callId ?? ""), ...block.name !== void 0 && block.name.length > 0 ? { name: block.name } : {}, argumentsDelta: event.delta };
				break;
			}
			case "response.function_call_arguments.done": {
				if (currentToolCall !== void 0 && typeof event.arguments === "string") currentToolCall.text = event.arguments;
				break;
			}
			case "response.completed": {
				const response = event.response;
				pendingUsage = response?.usage === void 0 ? void 0 : mapResponsesUsage(response.usage);
				const error = response?.error;
				const status = response?.status;
				// `response.error` is explicitly `null` on success, so only a
				// non-null error (or a failed status) is a failure.
				if (error != null || status === "failed") {
					const failure = { message: error?.message ?? "model response failed", code: error?.code ?? "MODEL_FAILED" };
					for (const chunk of finish({ kind: "error", failure })) yield chunk;
					return;
				}
				const output = response?.output;
				if (Array.isArray(output)) {
					// Reconcile tool-call blocks against the final output items: stream
					// item ids are encrypted on this subscription, so the authoritative
					// id/name/arguments come from the completed response.
					for (const item of output) {
						if (item?.type !== "function_call" || typeof item.call_id !== "string") continue;
						const block = toolBlocks.get(item.call_id);
						if (block === void 0) continue;
						block.callId = item.call_id;
						if (typeof item.name === "string") block.name = item.name;
						if (typeof item.arguments === "string") block.text = item.arguments;
					}
				}
				const called = Array.isArray(output) ? output.some((item) => item?.type === "function_call") : false;
				let reason;
				if (called) reason = { kind: "tool-calls" };
				else if (status === "incomplete") {
					const why = response?.incomplete_details?.reason;
					reason = why === "max_output_tokens" ? { kind: "max-tokens" } : { kind: "error", failure: { message: `model response incomplete${why !== void 0 ? `: ${why}` : ""}`, code: "INCOMPLETE" } };
				} else reason = { kind: "stop" };
				for (const chunk of finish(reason)) yield chunk;
				return;
			}
			case "response.failed": {
				const error = event.response?.error;
				const failure = { message: error?.message ?? "model response failed", code: error?.code ?? "MODEL_FAILED" };
				for (const chunk of finish({ kind: "error", failure })) yield chunk;
				return;
			}
			case "response.error": {
				const error = event.error;
				const failure = { message: error?.message ?? "model response error", code: error?.code ?? "MODEL_ERROR" };
				for (const chunk of finish({ kind: "error", failure })) yield chunk;
				return;
			}
		}
	}
	throw new LlmError("responses SSE stream ended without response.completed", "STREAM_CLOSED");
}
//#endregion

//#region lib/types/adapter.js
/**
 * `CopilotAdapter`: fetch + SSE against the GitHub Copilot chat-completions
 * endpoint, emitting harness StreamChunks. The adapter is transport-only:
 * connection facts arrive through a thunk resolved once per operation and the
 * Copilot session token through a per-request exchange over the caller-supplied
 * long-lived GitHub OAuth token, so the registering plugin owns validation,
 * layering, and credential policy.
 *
 * @module @deepseek-ai/dsh-llm-copilot/adapter
 */
var CopilotAdapter = class extends LlmAdapter {
	/**
	 * @param config - thunks the plugin supplies: `options()` resolves the live
	 *   connection facts (endpoint, catalog), `resolveApiKey()` resolves the
	 *   long-lived GitHub OAuth token per request, `resolveModels()` is an
	 *   async optional catalog fetch used by `listModels`/`discoverModels`.
	 */
	constructor(config) {
		super();
		this.config = config;
		this.tokenManager = null;
		this.catalog = new Map();
	}
	/** Replace the live catalog (from `/models` discovery) for routing + metadata. */
	setCatalog(models) {
		this.catalog = new Map(models.map((model) => [model.id, model]));
	}
	/** The best-known catalog entry for one model id: live discovery, then config. */
	modelEntry(model) {
		if (this.catalog.size > 0 && this.catalog.has(model)) return this.catalog.get(model);
		return this.config.options().models.find((entry) => entry.id === model);
	}
	providerInfo(provider) {
		return { id: provider, name: "Copilot (OAuth)" };
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		const connection = this.config.options();
		const base = this.catalog.size > 0 ? [...this.catalog.values()] : connection.models;
		return Promise.resolve(base.map((model) => ({
			provider,
			id: model.id,
			name: model.name ?? model.id,
			...model.description === void 0 ? {} : { description: model.description },
			inputModalities: ["text"]
		})));
	}
	resolveModel(provider, model, _signal) {
		const connection = this.config.options();
		const entry = this.modelEntry(model);
		const levels = entry?.reasoningEfforts;
		return Promise.resolve({
			...entry === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : { ...entry, provider, ...entry.name === void 0 ? {} : { name: entry.name }, inputModalities: ["text"] },
			context: { contextWindow: entry?.contextWindow ?? connection.defaultContextWindow },
			defaultMaxTokens: entry?.maxTokens ?? connection.maxTokens,
			reasoning: { efforts: modelReasoningEfforts(levels), defaultEffort: defaultReasoningEffort(levels) }
		});
	}
	/**
	 * Resolve (and, for this process, cache) a Copilot session-token manager for
	 * one request over its long-lived GitHub OAuth token. The manager is rebuilt
	 * when the backing OAuth token changes, so a refreshed credential reaches the
	 * edge without waiting for a stale session cache to expire.
	 */
	managerFor(oauthToken) {
		if (this.tokenManager === null || this.tokenManager.oauthToken !== oauthToken) {
			this.tokenManager = new CopilotTokenManager(oauthToken, this.config.logger);
		}
		return this.tokenManager;
	}
	async *stream(options) {
		const env = { stack: [], error: void 0, hasError: false };
		try {
			const connection = this.config.options();
			const oauthToken = await this.config.resolveApiKey(connection);
			const apiKey = await assertUsableApiKey(oauthToken, "llm-copilot", connection.apiKeyEnv);
			const sessionToken = await this.managerFor(apiKey).getToken(options.signal);
			const userId = this.config.resolveUserId();
			const consumer = new AbortController();
			const watchdog = __addDisposableResource(env, idleWatchdog(options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]), connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
			const iterator = this.request(options, watchdog.signal, connection, sessionToken, userId, () => {
				watchdog.pulse();
			})[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				while (true) {
					const result = await watchdog.next(iterator);
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError(`Copilot stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("Copilot request aborted by caller", "ABORTED", { cause: error });
				if (error instanceof LlmError) throw error;
				throw new LlmError(`Copilot API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
			} finally {
				consumer.abort("Copilot stream consumer stopped");
				if (!exhausted && iterator.return !== void 0) try {
					await iterator.return();
				} catch (_abortedTransportTeardown) {}
			}
		} catch (e) {
			env.error = e;
			env.hasError = true;
		} finally {
			__disposeResources(env);
		}
	}
	/**
	 * One Copilot chat-completions request. On 401 the session token is
	 * invalidated so the next attempt re-exchanges; this mirrors the edge
	 * contract that a stale session token is the caller's to replace.
	 */
	async *request(options, signal, connection, sessionToken, userId, onComment) {
		const isResponses = this.modelEntry(options.model)?.api === "responses";
		const body = isResponses ? serializeResponsesRequest(options, connection.defaults) : serializeRequest(options, connection.defaults);
		const payload = JSON.stringify(body);
		const headers = {
			authorization: `Bearer ${sessionToken}`,
			"content-type": "application/json",
			accept: "application/json",
			...copilotEdgeHeaders(),
			...attributionHeaders(),
			"x-deepseek-harness-user-id": String(userId),
			...options.sessionId !== void 0 ? { "x-deepseek-harness-session-id": String(options.sessionId) } : {},
			...options.purpose === "compaction" ? { "x-deepseek-harness-compact": "1" } : {}
		};
		let response;
		try {
			response = await fetch(`${connection.baseURL.replace(/\/+$/, "")}${isResponses ? "/responses" : "/chat/completions"}`, {
				method: "POST",
				headers,
				body: payload,
				signal
			});
		} catch (error) {
			if (signal.aborted) throw error;
			throw new LlmError(`Copilot API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		if (response.status === 401) {
			this.tokenManager?.invalidate();
			throw new LlmError("Copilot rejected the session token; the OAuth token or subscription may be invalid or expired — re-authorize with `dsh-copilot-auth login`", "AUTH", { status: response.status });
		}
		if (!response.ok) {
			let message = `Copilot API error (HTTP ${response.status})`;
			const body = await safeJson(response);
			const providerError = body?.error;
			const detail = [providerError?.code, providerError?.type, providerError?.message].filter(Boolean).join(" ");
			if (providerError?.message) message = providerError.message;
			const delay = providerRetryAfterMs(response.headers.get("Retry-After"));
			const id = requestId(response.headers);
			throw new LlmError(message, httpErrorCode(response.status, providerError), {
				status: response.status,
				...delay === void 0 ? {} : { providerRetryAfterMs: delay },
				...id === void 0 ? {} : { requestId: id }
			});
		}
		if (!response.body) throw new LlmError("Copilot API returned no response body", "EMPTY_RESPONSE");
		yield* (isResponses ? translateResponses(parseSse(response.body, onComment)) : translate(parseSse(response.body, onComment)));
	}
};
async function safeJson(response) {
	try {
		return await response.json();
	} catch {
		return void 0;
	}
}
//#endregion

//#region lib/types/catalog.js
/**
 * Optional live interrogation of the Copilot `/models` endpoint. Returns the
 * advertised model ids with their advertised capacities, falling back to a
 * hand-authored static catalog when the endpoint is unreachable or carries no
 * catalog the adapter can describe.
 */
const STATIC_MODELS = [
	{ id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, maxTokens: 16384, api: "chat" },
	{ id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000, maxTokens: 16384, api: "chat" },
	{ id: "gpt-4-turbo", name: "GPT-4 Turbo", contextWindow: 128000, maxTokens: 16384, api: "chat" },
	{ id: "gpt-4", name: "GPT-4", contextWindow: 8192, maxTokens: 8192, api: "chat" },
	{ id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", contextWindow: 200000, maxTokens: 16384, api: "chat", reasoningEfforts: ["low", "medium", "high", "max"] },
	{ id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", contextWindow: 200000, maxTokens: 16384, api: "chat", reasoningEfforts: ["low", "medium", "high", "max"] },
	{ id: "claude-haiku-4.5", name: "Claude Haiku 4.5", contextWindow: 200000, maxTokens: 64000, api: "chat" },
	{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow: 264000, maxTokens: 64000, api: "chat", reasoningEfforts: ["low", "medium", "high", "max"] },
	{ id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 264000, maxTokens: 64000, api: "chat", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
	{ id: "claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 264000, maxTokens: 64000, api: "chat", reasoningEfforts: ["low", "medium", "high", "max"] },
	{ id: "claude-opus-4.8", name: "Claude Opus 4.8", contextWindow: 264000, maxTokens: 64000, api: "chat", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
	{ id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 264000, maxTokens: 64000, api: "chat", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
	{ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", contextWindow: 264000, maxTokens: 64000, api: "chat", reasoningEfforts: ["minimal", "low", "medium", "high"] },
	{ id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", contextWindow: 264000, maxTokens: 64000, api: "chat", reasoningEfforts: ["minimal", "low", "medium", "high"] },
	{ id: "gpt-5-mini", name: "GPT-5 mini", contextWindow: 264000, maxTokens: 64000, api: "chat", reasoningEfforts: ["low", "medium", "high"] },
	{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex", contextWindow: 400000, maxTokens: 128000, api: "responses", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
	{ id: "gpt-5.4-mini", name: "GPT-5.4 mini", contextWindow: 400000, maxTokens: 128000, api: "responses", reasoningEfforts: ["none", "low", "medium", "high", "xhigh"] },
	{ id: "gpt-5.5", name: "GPT-5.5", contextWindow: 400000, maxTokens: 128000, api: "responses", reasoningEfforts: ["none", "low", "medium", "high", "xhigh"] },
	{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 328000, maxTokens: 128000, api: "responses", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] },
	{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 328000, maxTokens: 128000, api: "responses", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] },
	{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 328000, maxTokens: 128000, api: "responses", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] }
];
/** Fetch `/models` with the live session token; returns parsed entries or `null`. */
async function fetchLiveModels(sessionToken, baseURL, signal) {
	const headers = {
		...copilotEdgeHeaders(),
		authorization: `Bearer ${sessionToken}`,
		accept: "application/json"
	};
	let response;
	try {
		response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, { method: "GET", headers, signal });
	} catch {
		return null;
	}
	if (!response.ok) return null;
	let body;
	try {
		body = await response.json();
	} catch {
		return null;
	}
	const data = body?.data;
	if (!Array.isArray(data)) return null;
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const raw of data) {
		const entry = raw;
		const id = typeof entry?.id === "string" && entry.id.length > 0 ? entry.id : void 0;
		if (id === void 0 || seen.has(id)) continue;
		seen.add(id);
		const endpoints = Array.isArray(entry?.supported_endpoints) ? entry.supported_endpoints : [];
		const limits = entry?.capabilities?.limits;
		const supports = entry?.capabilities?.supports;
		models.push({
			id,
			name: typeof entry?.name === "string" && entry.name.length > 0 ? entry.name : id,
			api: endpoints.includes("/chat/completions") ? "chat" : endpoints.includes("/responses") ? "responses" : "chat",
			...limits?.max_context_window_tokens !== void 0 ? { contextWindow: limits.max_context_window_tokens } : {},
			...limits?.max_output_tokens !== void 0 ? { maxTokens: limits.max_output_tokens } : {},
			...Array.isArray(supports?.reasoning_effort) ? { reasoningEfforts: supports.reasoning_effort } : {}
		});
	}
	return models.length > 0 ? models : null;
}
/**
 * Validate an optional static model override list supplied in config. A route
 * with no `models` and no live catalog falls back to {@link STATIC_MODELS}.
 */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? STATIC_MODELS).map((model) => {
		if (model.id.length === 0) throw new Error("llm-copilot: catalog model ids must be non-empty");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-copilot: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`llm-copilot: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`llm-copilot: catalog model "${model.id}" maxTokens must be a positive integer`);
		if (seen.has(model.id)) throw new Error(`llm-copilot: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			...model.api === void 0 ? {} : { api: model.api },
			...model.reasoningEfforts === void 0 ? {} : { reasoningEfforts: model.reasoningEfforts }
		};
	});
}
//#endregion

//#region lib/types/config.js
/**
 * Configuration schema and provider-profile resolution for the Copilot adapter.
 * The composition entry and a user-settings layer merge per the same shape used
 * by dsh-llm-deepseek; a profile's `apiKeyEnv` is a reference to the credential
 * that holds the long-lived GitHub OAuth token produced by the device flow.
 *
 * @module @deepseek-ai/dsh-llm-copilot/config
 */
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	api: z.union(["chat", "responses"]),
	reasoningEfforts: z.array(z.string())
});
const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string(),
	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	models: z.array(catalogModel).default(STATIC_MODELS),
	discoverModels: z.boolean().default(true),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema
});
/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = "COPILOT_BASE_URL";
/**
 * The one explicit resolve step from raw config to validated connection facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here — for the composition entry at load and
 * for each settings snapshot at its first use.
 */
function resolveAdapterOptions(config, environment) {
	return {
		apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
		baseURL: config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? COPILOT_CHAT_URL.replace("/chat/completions", ""),
		defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
		models: resolveModels(config.models),
		discoverModels: config.discoverModels ?? true,
		streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-copilot: retryPolicy"),
		defaults: {}
	};
}
//#endregion

//#region lib/types/index.js
/**
 * Register a {@link CopilotAdapter} for the `copilot-oauth` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `llm-copilot` user-settings section under the
 * optional `ctx.settings` seam and resolves the long-lived GitHub OAuth token
 * through the optional credential seam (`ctx.credentials`), so a changed base
 * URL, catalog, or token reaches the very next request without restarting
 * anything, while an in-flight stream keeps the facts it started with.
 *
 * GitHub Copilot requires an OAuth device-flow login to produce that token; run
 * `dsh-copilot-auth login` once (or set `GITHUB_COPILOT_TOKEN` in your
 * environment / credential store) to obtain it.
 *
 * @module @deepseek-ai/dsh-llm-copilot
 */
const name = "llm-copilot";
const inject = ["llm"];
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	/** Resolve the live settings snapshot once per operation, memoizing by identity. */
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-copilot: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	/**
	 * Resolve one provider route's GitHub OAuth token per request: the named
	 * credential reference first (via the credential seam), then the trusted
	 * launch environment as a fallback for CI/dev. Absence fails the request
	 * with `MISSING_CREDENTIAL` naming every configuration entry point; the
	 * route stays registered and the catalog stays browsable.
	 */
	const resolveApiKey = async (connection) => {
		const ref = connection.apiKeyEnv;
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(ref);
			if (hit !== void 0) return hit.value;
		} else {
			const ambient = launchEnvironmentOf(ctx).get(ref);
			if (ambient !== void 0 && ambient.value.length > 0) return ambient.value;
		}
		throw new LlmError(`llm-copilot: no GitHub OAuth token for provider route "${PROVIDER}"; its profile resolves ${ref}, which is not set — run \`dsh-copilot-auth login\` to obtain one, or store ${ref} through the credentials service / export it in the launching environment`, "MISSING_CREDENTIAL");
	};
	let userId;
	const resolveUserId = () => userId ??= getOrCreateAnonymousUserId();
	const adapter = new CopilotAdapter({
		options,
		resolveApiKey,
		resolveUserId,
		logger: ctx.logger
	});
	/**
	 * Best-effort live catalog fill at boot so request routing (chat vs
	 * /responses) and per-model reasoning metadata are ready before the first
	 * selector-driven discovery completes. Failures are silent: the static
	 * catalog still serves and a later discovery replaces it.
	 */
	(async () => {
		try {
			const connection = options();
			const oauthToken = await resolveApiKey(connection);
			const usable = await assertUsableApiKey(oauthToken, "llm-copilot", connection.apiKeyEnv);
			const sessionToken = await adapter.managerFor(usable).getToken();
			const discovered = await fetchLiveModels(sessionToken, connection.baseURL);
			if (discovered !== null) adapter.setCatalog(discovered);
		} catch (error) {
			ctx.logger.debug("llm-copilot: live catalog fill failed; the static catalog will serve", error);
		}
	})();
	const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
	let registeredPolicy = options().retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "Copilot (OAuth)",
		settingsNs: NS,
		settingsPath: []
	}]);
	/**
	 * Live model discovery against Copilot's `/models` endpoint. A route's
	 * already-resolved OAuth token is used for the one-shot probe, so an
	 * unconfigured route is asked unauthenticated and answers 401 — reported as
	 * a discovery failure rather than guessed.
	 */
	ctx.llm.registerModelDiscovery(NS, async (request) => {
		const connection = options();
		const baseURL = request.baseURL ?? connection.baseURL;
		const apiKey = request.apiKey ?? await resolveApiKey(connection);
		let token;
		try {
			token = await exchangeCopilotToken(apiKey, request.signal);
		} catch (error) {
			if (error instanceof LlmError && error.code === "AUTH") throw new LlmError("Copilot model discovery rejected the GitHub OAuth token; run `dsh-copilot-auth login` or check the token's scopes — a profile naming no credential is probed unauthenticated and fails here", "DISCOVERY_FAILED", { cause: error });
			throw error;
		}
		const discovered = await fetchLiveModels(token.token, baseURL, request.signal);
		if (discovered !== null) adapter.setCatalog(discovered);
		if (discovered === null) {
			// Fall back to the static catalog the configuration resolved, so a
			// degraded endpoint still presents a browsable list.
			return connection.models.map((model) => ({
				id: model.id,
				...model.name === void 0 ? {} : { name: model.name },
				...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
				...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
			}));
		}
		return discovered;
	});
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: ensureRegistrationFacts
	});
}
function launchEnvironmentOf(ctx) {
	return ctx.get("launchEnvironment");
}
export { Config, CopilotAdapter, CopilotTokenManager, PROVIDER, STATIC_MODELS, apply, exchangeCopilotToken, name, inject };
