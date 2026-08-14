// Type-only surface for @deepseek-ai/dsh-llm-copilot.
// Re-declare the small public API the Cordis host imports; the runtime shape is
// plain JavaScript in lib/index.js.
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";

/** The single provider route this plugin owns. */
export const PROVIDER: "copilot-oauth";

/** Static fallback model catalog used when live /models discovery is unavailable. */
export interface CopilotModel {
	id: string;
	name?: string;
	description?: string;
	contextWindow?: number;
	maxTokens?: number;
}
/** Static fallback catalog. */
export const STATIC_MODELS: readonly CopilotModel[];

/** Resolved connection facts the adapter reads per request. */
export interface CopilotConnection {
	apiKeyEnv: import("@deepseek-ai/dsh-credentials").CredentialRef;
	baseURL: string;
	defaultContextWindow: number;
	maxTokens: number;
	models: readonly CopilotModel[];
	discoverModels: boolean;
	streamIdleTimeoutMs: number;
	retryPolicy: unknown;
	defaults: Record<string, never>;
}

/** Configuration thunks the plugin supplies to the adapter. */
export interface CopilotAdapterConfig {
	options: () => CopilotConnection;
	resolveApiKey: (connection: CopilotConnection) => Promise<string>;
	resolveUserId: () => string;
	logger: {
		debug(message: string): void;
		warn(message: string, ...rest: unknown[]): void;
		error(message: string, ...rest: unknown[]): void;
	};
}

/**
 * Adapter streaming GitHub Copilot chat completions as harness StreamChunks.
 * The long-lived GitHub OAuth token (held in the credential seam) is exchanged
 * on demand for a short-lived Copilot API session token, cached and refreshed.
 */
export declare const CopilotAdapter: {
	new (config: CopilotAdapterConfig): LlmAdapter;
	prototype: LlmAdapter;
};

/** Two-tier auth: GitHub OAuth token → Copilot API session token. */
export interface CopilotTokenManagerInstance {
	readonly oauthToken: string;
	readonly cached: { token: string; expiresAt: number } | null;
	getToken(signal?: AbortSignal): Promise<string>;
	invalidate(): void;
}
export declare const CopilotTokenManager: {
	new (oauthToken: string, logger: { debug(message: string): void }): CopilotTokenManagerInstance;
};

/** Exchange a GitHub OAuth access token for a Copilot API session token. */
export declare function exchangeCopilotToken(oauthToken: string, signal?: AbortSignal): Promise<{ token: string; expiresAt: number }>;

/** Schemastery-validated plugin config (the `llm-copilot` settings schema). */
export declare const Config: Record<string, unknown>;

/** Cordis plugin contract. */
export const name: "llm-copilot";
export const inject: readonly ["llm"];
export declare function apply(ctx: import("@deepseek-ai/cordis").Context, config: unknown): void;
