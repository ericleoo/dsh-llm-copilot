#!/usr/bin/env node
import { argv, exit, stderr, stdout } from "node:process";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

/**
 * `dsh-copilot-auth` — perform the GitHub OAuth device-flow login for the
 * `@deepseek-ai/dsh-llm-copilot` provider and persist the resulting long-lived
 * GitHub OAuth access token to the harness credential store
 * (`$DSH_HOME/.credentials.yaml` under `GITHUB_COPILOT_TOKEN`), where the
 * adapter resolves it per request and exchanges it for a short-lived Copilot
 * API session token.
 *
 * Flow (RFC 8628 device authorization grant), using the same VS Code Copilot
 * client id and editor headers the IDE sends so Copilot's edge accepts the
 * resulting bearer token:
 *
 *   1. POST https://github.com/login/device/code       → device_code, user_code, verification_uri
 *   2. Tell the user to visit verification_uri and enter the user_code.
 *   3. Poll  https://github.com/login/oauth/access_token → authorization_pending / … / access_token
 *
 * On success the access token is written to the credentials document (creating
 * `$DSH_HOME` and the file with owner-only mode if needed). The credentials
 * service's file watcher picks up the change and publishes it through the seam,
 * so no dsh restart is required.
 *
 * @module @deepseek-ai/dsh-llm-copilot/cli
 */

const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_COPILOT_SCOPE = "read:user";
const GITHUB_COPILOT_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_COPILOT_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_COPILOT_USER_AGENT = "GithubCopilot/1.155.0";
const GITHUB_COPILOT_INTERNAL_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const CREDENTIALS_FILENAME = ".credentials.yaml";
const DSH_HOME_ENV = "DSH_HOME";
const DSH_HOME_DIR_NAME = ".dsh";

/** Resolve the harness home: `$DSH_HOME` or `~/.dsh`, matching dsh-home-paths. */
function resolveDshHome() {
	const fromEnv = process.env[DSH_HOME_ENV];
	if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolveHomePath(fromEnv);
	return join(homedir(), DSH_HOME_DIR_NAME);
}
function resolveHomePath(p) {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return resolve(p);
}
/** Resolve `$DSH_HOME/.credentials.yaml`, honoring an explicit DSH_HOME / env. */
function credentialsFile() {
	return join(resolveDshHome(), CREDENTIALS_FILENAME);
}
/** Symbolic display: `~/.dsh` for the default home, `$DSH_HOME` otherwise. */
function dshHomeDisplay(resolvedHome) {
	const defaultHome = join(homedir(), DSH_HOME_DIR_NAME);
	return resolvedHome === defaultHome ? `~/${DSH_HOME_DIR_NAME}` : "$DSH_HOME";
}

/**
 * Minimal flat-YAML read/write for the `dsh-credentials-local` document format
 * (a top-level mapping of `ref: value` lines). This avoids a runtime dependency
 * on the `yaml` package so the auth CLI resolves its imports from Node
 * built-ins alone — it must work whether the plugin was installed from the
 * registry or linked from a local checkout (`dsh plugin add .`).
 *
 * The writers operate on the source text line-by-line, so comments and the
 * formatting of every untouched entry survive verbatim; only the target
 * reference's line is updated, or a fresh `ref: value` line is appended. A
 * GitHub OAuth token (`gho_…`) is a safe YAML scalar, so no quoting is needed.
 */
const REF_LINE_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;
/** Parse a credentials document into a `Map(ref → value)`, preserving insertion order. */
function parseFlatYaml(text) {
	const entries = new Map();
	for (const line of text.split(/\r?\n/)) {
		const match = REF_LINE_RE.exec(line);
		if (match === null) continue;
		const value = match[3].trim();
		if (value.length === 0) continue;
		entries.set(match[2], value);
	}
	return entries;
}

/** Headers the device-flow + token-exchange endpoints accept. */
function deviceHeaders() {
	return {
		accept: "application/json",
		"content-type": "application/json",
		"user-agent": GITHUB_COPILOT_USER_AGENT,
		"editor-version": "vscode/1.95.0",
		"editor-plugin-version": "copilot-chat/0.22.4",
		"copilot-integration-id": "vscode-chat"
	};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, exitCode) {
	stderr.write(`dsh-copilot-auth: ${message}\n`);
	exit(exitCode ?? 1);
}

async function requestDeviceCode() {
	const res = await fetch(GITHUB_COPILOT_DEVICE_CODE_URL, {
		method: "POST",
		headers: deviceHeaders(),
		body: JSON.stringify({ client_id: GITHUB_COPILOT_CLIENT_ID, scope: GITHUB_COPILOT_SCOPE })
	});
	const text = await res.text();
	if (!res.ok) fail(`device code request failed (HTTP ${res.status}): ${text}`, 2);
	let device;
	try {
		device = JSON.parse(text);
	} catch (e) {
		fail(`device code response was not JSON: ${e.message}`, 2);
	}
	if (!device?.device_code || !device?.user_code || !device?.verification_uri) {
		fail(`device code response is malformed — GitHub returned: ${text}`, 2);
	}
	return device;
}

/**
 * Poll the access-token endpoint until the user authorizes, returns the access
 * token, or throws on denial/timeout. `onPrompt` is called once, before the
 * polling loop, with the information the user needs.
 */
async function pollForAccessToken(device, onPrompt) {
	onPrompt({
		verificationUri: device.verification_uri,
		userCode: device.user_code,
		expiresIn: device.expires_in,
		interval: device.interval
	});
	const expiresAt = Date.now() + (device.expires_in ?? 900) * 1000;
	let pollInterval = Math.max(1, device.interval ?? 5) * 1000;
	let consecutiveFailures = 0;
	while (Date.now() < expiresAt) {
		await sleep(pollInterval);
		const res = await fetch(GITHUB_COPILOT_ACCESS_TOKEN_URL, {
			method: "POST",
			headers: deviceHeaders(),
			body: JSON.stringify({
				client_id: GITHUB_COPILOT_CLIENT_ID,
				device_code: device.device_code,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code"
			})
		});
		const text = await res.text();
		if (!res.ok) {
			if (consecutiveFailures++ >= 5) fail(`access token poll failed permanently (HTTP ${res.status}): ${text}`, 2);
			pollInterval = Math.min(pollInterval + 2000, 30000);
			continue;
		}
		let body;
		try {
			body = JSON.parse(text);
		} catch (e) {
			fail(`access token response was not JSON: ${e.message}`, 2);
		}
		consecutiveFailures = 0;
		if (body?.access_token) return body.access_token;
		switch (body?.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				pollInterval += 5000;
				continue;
			case "access_denied":
				fail("you denied the GitHub device login — re-run `dsh-copilot-auth login` to try again", 3);
			case "expired_token":
				fail("the GitHub device code expired before authorization completed — re-run `dsh-copilot-auth login`", 3);
			default:
				fail(`unexpected device-flow error: ${body?.error ?? "unknown"} ${body?.error_description ?? ""}`, 2);
		}
	}
	fail("the GitHub device code expired before authorization completed — re-run `dsh-copilot-auth login`", 3);
}

/**
 * Write the OAuth token into the harness credentials document. The file is the
 * provider-managed writable credential seam; the writer edits the document
 * in place so existing entries (and their comments/formatting) are preserved
 * verbatim — only the target reference's line is replaced, or a new line is
 * appended. Owner-only mode (0600) is applied on create/replace, matching the
 * contract the `dsh-credentials-local` reader enforces.
 */
async function persistToken(token, ref) {
	const file = credentialsFile();
	const dshHome = resolveDshHome();
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	const updated = updateCredentialLine(text, ref, token);
	await writeFile(file, updated, { mode: 0o600 });
	// Verify owner-only; the credentials-local provider refuses to read a file
	// any other user can read.
	let mode;
	try {
		mode = (await stat(file)).mode;
	} catch {}
	if (mode !== undefined && (mode & 0o077) !== 0) {
		// Best-effort repair to owner-only; if chmod fails we only warn.
		try { await chmod(file, 0o600); } catch {}
		stderr.write(`dsh-copilot-auth: warning: ${file} was group/other-readable; corrected to 0600\n`);
	}
	return file;
}
/**
 * Replace the existing `ref: ...` line, or append a fresh one. Operates on raw
 * text so comments and unrelated entries are untouched. If the ref appears on
 * multiple lines (malformed document) the first match wins and later copies are
 * left intact — the credentials reader rejects duplicate keys anyway.
 */
function updateCredentialLine(text, ref, value) {
	const lines = text.split(/\r?\n/);
	const prefix = `${ref}: `;
	let replaced = false;
	for (let i = 0; i < lines.length; i++) {
		const match = REF_LINE_RE.exec(lines[i]);
		if (match !== null && match[2] === ref) {
			lines[i] = `${ref}: ${value}`;
			replaced = true;
			break;
		}
	}
	if (!replaced) {
		// Append, ensuring exactly one trailing newline before the new line.
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
		lines.push(`${ref}: ${value}`);
	}
	return lines.join("\n") + "\n";
}
/**
 * Remove the `ref: ...` line from the source text, preserving every other line
 * (comments, blank lines, unrelated entries) verbatim. If the ref is not
 * present the text is returned unchanged.
 */
function removeCredentialLine(text, ref) {
	const lines = text.split(/\r?\n/);
	const out = [];
	for (const line of lines) {
		const match = REF_LINE_RE.exec(line);
		if (match !== null && match[2] === ref) continue;
		out.push(line);
	}
	return out.join("\n") + "\n";
}

/**
 * Try to auto-open the verification URI in the platform's default browser.
 * Best-effort: a failure leaves the printed URL as the fallback.
 */
async function tryOpenBrowser(uri) {
	const { exec } = await import("node:child_process");
	const start = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
	exec(`"${start}" "${uri}"`, (error) => {
		if (error) stderr.write("  (could not auto-open browser; open the URL above manually)\n");
	});
}

const commands = {
	async login(args) {
		const ref = args.ref ?? "GITHUB_COPILOT_TOKEN";
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) fail(`invalid credential ref "${ref}" — must be a POSIX identifier`, 2);
		stdout.write("Starting GitHub Copilot OAuth device flow...\n");
		const device = await requestDeviceCode();
		stdout.write(`\nGitHub Copilot wants you to sign in.\n\n`);
		stdout.write(`  1. Open this URL in your browser:\n     ${device.verification_uri}\n`);
		stdout.write(`  2. Enter the code: ${device.user_code}\n`);
		// Auto-open when a TTY is available; otherwise just print the URL.
		if (process.stdin.isTTY) {
			stdout.write("  Opening your browser...\n");
			await tryOpenBrowser(device.verification_uri);
		}
		stdout.write("\nWaiting for you to authorize in the browser...\n");
		const token = await pollForAccessToken(device, () => {});
		const file = await persistToken(token, ref);
		stdout.write(`\n✓ GitHub Copilot token saved to ${dshHomeDisplay(resolveDshHome())}/${CREDENTIALS_FILENAME} under "${ref}".\n`);

		stdout.write("The adapter will exchange it for a Copilot API token automatically.\n");
	},
	async status(args) {
		const ref = args.ref ?? "GITHUB_COPILOT_TOKEN";
		const file = credentialsFile();
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch {
			stdout.write(`No credentials file at ${file}.\n`);
			exit(4);
		}
		const value = parseFlatYaml(text).get(ref);
		if (value === undefined) {
			stdout.write(`No "${ref}" credential is set. Run "dsh-copilot-auth login".\n`);
			exit(4);
		}
		// Prove the OAuth token is still good by exchanging it for a Copilot
		// session token (cheap, one request, no chat completion).
		try {
			const session = await exchangeForStatus(String(value));
			stdout.write(`GitHub Copilot: authenticated (${ref}).\n`);
			stdout.write(`  session token expires at: ${new Date(session.expires_at * 1000).toISOString()}\n`);
		} catch (error) {
			stdout.write(`GitHub Copilot: ${ref} is set but rejected by Copilot — re-authorize with "dsh-copilot-auth login".\n`);
			stderr.write(`  ${error.message}\n`);
			exit(5);
		}
	},
	async logout(args) {
		const ref = args.ref ?? "GITHUB_COPILOT_TOKEN";
		const file = credentialsFile();
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch (e) {
			if (e.code === "ENOENT") {
				stdout.write("No credentials file to update.\n");
				return;
			}
			throw e;
		}
		const entries = parseFlatYaml(text);
		if (!entries.has(ref)) {
			stdout.write(`No "${ref}" credential to remove.\n`);
			return;
		}
		await writeFile(file, removeCredentialLine(text, ref), { mode: 0o600 });
		stdout.write(`Removed "${ref}" from ${file}.\n`);
	},
};

/** Exchange an OAuth token for a session token (used only by `status`). */
async function exchangeForStatus(accessToken) {
	const res = await fetch(GITHUB_COPILOT_INTERNAL_TOKEN_URL, {
		method: "GET",
		headers: { ...deviceHeaders(), authorization: `token ${accessToken}` }
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`token exchange failed (HTTP ${res.status}): ${text}`);
	return JSON.parse(text);
}

function printHelp() {
	stdout.write(`dsh-copilot-auth <command> [options]

Commands:
  login   Run the GitHub OAuth device flow and store the Copilot OAuth token.
          Prints a verification URL + code; opens a browser when possible.
  status  Check whether a stored GitHub OAuth token is set and still valid.
  logout  Remove the stored GitHub OAuth token.

Options:
  --ref <name>   Credential reference to read/write (default: GITHUB_COPILOT_TOKEN)
  -h, --help   Show this help.
`);
}

const args = argv.slice(2);
const command = args[0];
if (command === undefined || command === "-h" || command === "--help") {
	printHelp();
	exit(command === undefined ? 0 : 0);
}
const rest = args.slice(1);
const flags = {};
for (let i = 0; i < rest.length; i++) {
	const arg = rest[i];
	if (arg === "--ref") flags.ref = rest[++i];
	else fail(`unknown argument ${arg}`, 2);
}
const cmd = commands[command];
if (cmd === undefined) fail(`unknown command "${command}" (see --help)`, 2);
cmd(flags).catch((error) => fail(error.message, 1));
