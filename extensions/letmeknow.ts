// Puts a Pi session in letmeknow: an interactive one, and any with a name (`pi --name <name>`), as the letmeknow session
// of that name, or else `pi-<end of its id>`, which goes when the Pi session ends in no group. letmeknow runs as
// `npx -y @letmeknow/cli@<minor>`, the latest release of the minor version this extension speaks, as its agents run it.
// What the letmeknow session prints reaches the agent as a message that starts a turn; its `ready` only names the
// session, which the system prompt and status line show.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLI = "@letmeknow/cli@0.14";
// On Windows npx is a script, which only a shell runs.
const shell = process.platform === "win32";
const run = promisify(execFile);
const letmeknow = (...args: string[]) => run("npx", ["-y", CLI, ...args], { shell });

export default function (pi: ExtensionAPI): void {
	let session: { handle: string; listen: ChildProcess; removable: boolean } | undefined;
	let pending: TextContent[] | undefined;

	function notify(text: string): void {
		const queued = pending !== undefined;
		pending ??= [];
		// Pi retains this array until message_start; later lines join the same queued message.
		pending.push({ type: "text", text });
		if (!queued) pi.sendMessage({ customType: "letmeknow", content: pending, display: true }, { deliverAs: "steer", triggerTurn: true });
	}

	pi.on("message_start", ({ message }) => {
		if (message.role === "custom" && message.customType === "letmeknow" && message.content === pending) pending = undefined;
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle()) pending = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		const name = ctx.sessionManager.getSessionName();
		if (!name && ctx.mode !== "tui") return;
		// A letmeknow handle has letters, digits, '.', '_' and '-'.
		const handle = name ? name.replace(/[^\w.-]+/g, "-") : `pi-${ctx.sessionManager.getSessionId().slice(-12)}`;
		const listen = spawn("npx", ["-y", CLI, "--session", handle, "listen"], { stdio: ["ignore", "pipe", "pipe"], shell });
		const current = { handle, listen, removable: !name };
		session = current;
		process.env.LETMEKNOW_SESSION = handle;
		ctx.ui.setStatus("letmeknow", `letmeknow: ${handle}`);
		let errors = "";
		listen.stderr!.on("data", chunk => (errors = (errors + chunk).slice(-2000)));
		listen.on("error", error => ctx.ui.notify(`letmeknow: ${error.message}`, "error"));
		listen.on("exit", code => session === current && ctx.ui.notify(`letmeknow stopped (exit ${code}): ${errors.trim()}`, "error"));
		createInterface({ input: listen.stdout! }).on("line", line => session === current && JSON.parse(line).type !== "ready" && notify(line));
	});

	pi.on("before_agent_start", event => {
		if (!session) return;
		event.systemPromptOptions.sections.letmeknow = `You are in letmeknow as its session ${session.handle}, which runs already: what it prints reaches you as messages, and only what you send with it reaches anyone. Read \`npx -y ${CLI} skill\` before you first use letmeknow.`;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!session) return;
		const { handle, listen, removable } = session;
		session = undefined;
		delete process.env.LETMEKNOW_SESSION;
		ctx.ui.setStatus("letmeknow", undefined);
		const { sessions } = JSON.parse((await letmeknow("sessions")).stdout) as { sessions: { handle: string; groups: unknown[] }[] };
		if (removable && sessions.some(s => s.handle === handle && !s.groups.length)) await letmeknow("sessions", "remove", handle);
		// Killing npx's shell would leave letmeknow running.
		else if (shell) await run("taskkill", ["/T", "/F", "/PID", String(listen.pid)]);
		else listen.kill();
	});
}
