// Puts a Pi session in letmeknow: an interactive one, and any with a name (`pi --name <name>`), as the letmeknow session
// of that name, or else `pi-<end of its id>`, which goes when the Pi session ends in no group. It runs letmeknow's own
// binary, the newest release of the minor version it speaks, which it fetches from npm into ~/.cache/pi-letmeknow. What
// the letmeknow session prints reaches the agent as a message that starts a turn; its `ready` only names the session,
// which the system prompt and status line show. The agent's `letmeknow` tool runs the same binary for its commands.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { type TextContent, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MINOR = "0.17";
// Termux's node says android; the static Linux binaries run there.
const TARGET = `${process.platform === "android" ? "linux" : process.platform}-${process.arch}`;
const CACHE = join(homedir(), ".cache", "pi-letmeknow", TARGET);
const EXECUTABLE = process.platform === "win32" ? "letmeknow.exe" : "letmeknow";
const run = promisify(execFile);
// Pi loads a package once, but from npm, from git and from a path this extension is three packages: of the copies a Pi
// process loads, the first to start a session puts it in letmeknow, until that session ends.
const claim = globalThis as { piLetmeknow?: true };

async function install(warn: (message: string) => void): Promise<string> {
	await mkdir(CACHE, { recursive: true });
	let versions!: Record<string, { dist: { tarball: string; integrity: string } }>;
	let available: string[];
	let offline: Error | undefined;
	try {
		const found = await fetch(`https://registry.npmjs.org/@letmeknow/${TARGET}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
		if (!found.ok) throw new Error(`npm has no @letmeknow/${TARGET} (${found.status})`);
		({ versions } = await found.json() as { versions: typeof versions });
		available = Object.keys(versions);
	} catch (error) {
		offline = error as Error;
		available = (await readdir(CACHE, { withFileTypes: true }))
			.filter(entry => entry.isDirectory() && existsSync(join(CACHE, entry.name, "bin", EXECUTABLE)))
			.map(entry => entry.name);
	}
	const latest = available
		.filter(version => version.startsWith(`${MINOR}.`) && /^\d+\.\d+\.\d+$/.test(version))
		.sort((a, b) => Number(a.split(".")[2]) - Number(b.split(".")[2]))
		.at(-1);
	if (!latest) throw offline ?? new Error(`letmeknow has no ${MINOR} release for ${TARGET}`);
	const dest = join(CACHE, latest);
	const executable = join(dest, "bin", EXECUTABLE);
	if (offline) warn(`letmeknow: cannot look for a newer ${MINOR} release (${offline.message}); running cached ${latest}`);
	if (existsSync(executable)) return executable;
	const { tarball, integrity } = versions[latest].dist;
	const fetched = await fetch(tarball);
	if (!fetched.ok) throw new Error(`cannot fetch letmeknow ${latest} (${fetched.status})`);
	const bytes = Buffer.from(await fetched.arrayBuffer());
	if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) throw new Error(`letmeknow ${latest} does not match its integrity`);
	const tmp = await mkdtemp(join(CACHE, "new-"));
	try {
		await writeFile(join(tmp, "package.tgz"), bytes);
		// GNU tar on Windows takes the `C:` of an absolute path for a remote host.
		await run("tar", ["-xzf", "package.tgz"], { cwd: tmp });
		await access(join(tmp, "package", "bin", EXECUTABLE));
		try {
			await rename(join(tmp, "package"), dest);
		} catch (error) {
			// Another installer may have published the same complete package first (Windows can report EPERM).
			if (!existsSync(executable)) throw error;
		}
	} finally {
		await rm(tmp, { recursive: true });
	}
	return executable;
}

export default function (pi: ExtensionAPI): void {
	let session: { handle: string; removable: boolean; executable: Promise<string>; listen?: ChildProcess } | undefined;
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

	const tool = defineTool({
		name: "letmeknow",
		label: "letmeknow",
		description:
			"Runs a letmeknow command in this session's letmeknow session, which runs already: `args` as the command takes them, as [\"send\", \"--to\", \"ann\", \"hi\"], and `input` for an argument \"-\" to read. Answers with what the command prints.",
		parameters: Type.Object({
			args: Type.Array(Type.String()),
			input: Type.Optional(Type.String()),
		}),
		async execute(_id, { args, input }, signal, _onUpdate, ctx) {
			// A Pi session that followed one in letmeknow, in the same process, may be in none.
			if (!session) throw new Error("this Pi session is not in letmeknow");
			const current = session;
			const executable = await current.executable;
			if (session !== current) throw new Error("this Pi session has left letmeknow");
			const running = run(executable, ["--session", current.handle, ...args], { cwd: ctx.cwd, signal, maxBuffer: 64 << 20 });
			running.child.stdin!.end(input ?? "");
			try {
				return { content: [{ type: "text", text: (await running).stdout }], details: undefined };
			} catch (error) {
				throw new Error((error as { stderr?: string }).stderr?.trim() || (error as Error).message);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const name = ctx.sessionManager.getSessionName();
		if ((!name && ctx.mode !== "tui") || claim.piLetmeknow) return;
		claim.piLetmeknow = true;
		pi.registerTool(tool);
		// A letmeknow handle has letters, digits, '.', '_' and '-'.
		const handle = name ? name.replace(/[^\w.-]+/g, "-") : `pi-${ctx.sessionManager.getSessionId().slice(-12)}`;
		const current: NonNullable<typeof session> = {
			handle, removable: !name,
			executable: install(message => ctx.ui.notify(message, "warning")),
		};
		session = current;
		process.env.LETMEKNOW_SESSION = handle;
		current.executable.then(
			executable => {
				if (session !== current) return;
				const listen = spawn(executable, ["--session", handle, "listen"], { stdio: ["ignore", "pipe", "pipe"] });
				current.listen = listen;
				ctx.ui.setStatus("letmeknow", `letmeknow: ${handle}`);
				let errors = "";
				listen.stderr!.on("data", chunk => (errors = (errors + chunk).slice(-2000)));
				listen.on("error", error => ctx.ui.notify(`letmeknow: ${error.message}`, "error"));
				listen.on("exit", code => session === current && ctx.ui.notify(`letmeknow stopped (exit ${code}): ${errors.trim()}`, "error"));
				createInterface({ input: listen.stdout! }).on("line", line => session === current && JSON.parse(line).type !== "ready" && notify(line));
			},
			error => ctx.ui.notify(`letmeknow: ${error.message}`, "error")
		);
	});

	pi.on("before_agent_start", event => {
		if (!session) return;
		event.systemPromptOptions.sections.letmeknow = `You are in letmeknow as its session ${session.handle}, which runs already: what it prints reaches you as messages, and only what you send with it reaches anyone. Your letmeknow tool runs its commands; read \`skill\` with it before you first use letmeknow.`;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!session) return;
		const { handle, removable, listen, executable } = session;
		session = undefined;
		delete claim.piLetmeknow;
		delete process.env.LETMEKNOW_SESSION;
		ctx.ui.setStatus("letmeknow", undefined);
		// One whose letmeknow had not started yet has nothing to stop.
		if (!listen) return;
		const binary = await executable;
		const { sessions } = JSON.parse((await run(binary, ["sessions"])).stdout) as { sessions: { handle: string; groups: unknown[] }[] };
		if (removable && sessions.some(s => s.handle === handle && !s.groups.length)) await run(binary, ["sessions", "remove", handle]);
		else listen.kill();
	});
}
