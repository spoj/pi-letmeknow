// Puts a Pi session in letmeknow: an interactive one, and any with a name (`pi --name <name>`), as a new letmeknow session
// known by its fingerprint, which joins the groups of ~/.pi/agent/letmeknow.json and goes when the Pi session ends in no group;
// or as the session that file names to attach to, which runs on its own, while no other Pi session is attached to it. It runs
// letmeknow's own binary, the newest release of the minor version it speaks, which it fetches from npm into
// ~/.cache/pi-letmeknow, and /letmeknow-update runs the session again with a newer one, as the same session. The letmeknow
// session logs every event and prints what concerns the agent: those lines reach the agent as one message that starts a
// turn, once none came for a moment; its `ready` only gives the session's fingerprint, program and log, which the system
// prompt shows, and the status line the fingerprint, as other members know the session by it. The agent's `letmeknow` tool
// runs the session's program for its commands.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { type TextContent, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const MINOR = "0.24";
const TARGET = `${process.platform}-${process.arch}`;
const CACHE = join(homedir(), ".cache", "pi-letmeknow", TARGET);
const EXECUTABLE = process.platform === "win32" ? "letmeknow.exe" : "letmeknow";
const run = promisify(execFile);
// The groups each session joins as it starts, by id, and the session to attach to rather than start a new one, by
// fingerprint: `{ "join": ["<group id>"], "attach": "<fp>" }`.
const SETTINGS = join(homedir(), ".pi", "agent", "letmeknow.json");
// How long a sibling has to start and make its invite: back from a while away, its invite first catches up, up to about
// two minutes.
const INVITE_WAIT = 180_000;
// How long the lines the session prints wait for more before they wake the agent together.
const DEBOUNCE = 2000;
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

async function letmeknow(executable: string, args: string[], timeout = 0): Promise<Record<string, any>> {
	return JSON.parse((await run(executable, args, { timeout })).stdout);
}

// An invite into `group` from `sibling`, another session of this machine in it: a running one, or a stopped one that runs
// only until `use` is done with the link, or `signal` aborts as the Pi session ends. A sibling that has no invite within
// `INVITE_WAIT` fails, so that the next one is asked.
async function inviteFrom(executable: string, sibling: { fp: string; running?: boolean }, group: string, use: (link: string) => Promise<unknown>, signal: AbortSignal): Promise<void> {
	const invite = async (): Promise<string> => (await letmeknow(executable, ["--session", sibling.fp, "invite", "--group", group], INVITE_WAIT)).link;
	if (sibling.running) return void (await use(await invite()));
	const listen = spawn(executable, ["--session", sibling.fp, "listen"], { stdio: ["ignore", "pipe", "pipe"], signal });
	try {
		await new Promise<void>((resolve, reject) => {
			let errors = "";
			listen.stderr!.on("data", chunk => (errors += chunk));
			listen.on("error", reject);
			listen.on("exit", code => reject(new Error(`session ${sibling.fp} stopped (exit ${code}): ${errors.trim()}`)));
			setTimeout(() => reject(new Error(`session ${sibling.fp} was not ready within ${INVITE_WAIT / 1000} s`)), INVITE_WAIT).unref();
			createInterface({ input: listen.stdout! }).on("line", line => JSON.parse(line).type === "ready" && resolve());
		});
		await use(await invite());
	} finally {
		listen.kill();
	}
}

// Joins the session `fp` to each of `groups` it is not in, through a sibling: a running one first; until `signal` aborts.
async function joinListed(executable: string, fp: string, groups: string[], signal: AbortSignal): Promise<string[]> {
	if (!groups.length) return [];
	const { sessions } = (await letmeknow(executable, ["sessions"])) as { sessions: { fp: string; running?: boolean; groups?: string[] }[] };
	const warnings: string[] = [];
	for (const group of groups) {
		if (sessions.find(s => s.fp === fp)?.groups?.includes(group)) continue;
		const siblings = sessions.filter(s => s.fp !== fp && s.groups?.includes(group)).sort((a, b) => Number(!!b.running) - Number(!!a.running));
		const failures: string[] = [];
		for (const sibling of siblings) {
			signal.throwIfAborted();
			try {
				await inviteFrom(executable, sibling, group, link => letmeknow(executable, ["--session", fp, "join", link]), signal);
				break;
			} catch (error) {
				failures.push(`${sibling.fp}: ${(error as { stderr?: string }).stderr?.trim() || (error as Error).message}`);
			}
		}
		if (failures.length === siblings.length) warnings.push(`letmeknow: cannot join ${group} through a session of this machine${failures.length ? ` (${failures.join("; ")})` : ""}`);
	}
	return warnings;
}

export default function (pi: ExtensionAPI): void {
	let session: { executable: Promise<string>; ready: Promise<string>; settle: { resolve: (fp: string) => void; reject: (error: Error) => void }; stop: AbortController; restart?: (program: string, args: string[]) => void; listen?: ChildProcess; fp?: string; bin?: string; log?: string; attached?: boolean } | undefined;
	let pending: TextContent[] | undefined;
	let waiting: string[] = [];
	let timer: NodeJS.Timeout | undefined;

	function wake(line: string): void {
		waiting.push(line);
		clearTimeout(timer);
		timer = setTimeout(() => {
			const lines = waiting;
			waiting = [];
			notify(lines.join("\n"));
		}, DEBOUNCE);
	}

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
			const fp = await current.ready;
			if (session !== current) throw new Error("this Pi session has left letmeknow");
			const running = run(current.bin!, ["--session", fp, ...args], { cwd: ctx.cwd, signal, maxBuffer: 64 << 20 });
			running.child.stdin!.end(input ?? "");
			try {
				return { content: [{ type: "text", text: (await running).stdout }], details: undefined };
			} catch (error) {
				throw new Error((error as { stderr?: string }).stderr?.trim() || (error as Error).message);
			}
		},
	});

	const update = {
		description: `Runs this Pi session's letmeknow session again with the newest ${MINOR} release, as the same session, once the agent is idle`,
		async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
			const current = session;
			if (!current) return ctx.ui.notify("letmeknow: this Pi session is not in letmeknow", "error");
			const fp = await current.ready;
			if (current.attached) return ctx.ui.notify(`letmeknow: ${fp} runs on its own; run it again with the newer program to update it`, "warning");
			const program = await install(message => ctx.ui.notify(message, "warning"));
			const [from, to] = [current.bin!, program].map(path => basename(dirname(dirname(path))));
			if (from === to) return ctx.ui.notify(`letmeknow: ${fp} runs ${to}, the newest ${MINOR} release`, "info");
			await ctx.waitForIdle();
			// A session that stops in no group is deleted, so one in none runs again as a new session.
			const { groups } = await letmeknow(current.bin!, ["--session", fp, "groups"]);
			// The join the old run started goes no further, and stops a sibling it runs; the new run joins again.
			current.stop.abort();
			current.stop = new AbortController();
			// Tools wait for the session to run again.
			current.ready = new Promise<string>((resolve, reject) => (current.settle = { resolve, reject }));
			current.ready.then(next => ctx.ui.notify(`letmeknow: ${next} runs ${to}, updated from ${from}`, "info"), () => {});
			const old = current.listen!;
			current.listen = undefined;
			if (old.exitCode === null && old.signalCode === null) {
				const exited = new Promise(resolve => old.once("exit", resolve));
				old.kill();
				await exited;
			}
			if (session === current) current.restart!(program, groups ? ["--session", fp, "listen"] : ["listen"]);
		},
	};

	pi.on("session_start", (_event, ctx) => {
		if ((!ctx.sessionManager.getSessionName() && ctx.mode !== "tui") || claim.piLetmeknow) return;
		claim.piLetmeknow = true;
		pi.registerTool(tool);
		pi.registerCommand("letmeknow-update", update);
		let settle!: NonNullable<typeof session>["settle"];
		const ready = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
		// Tools wait for it; one never ready fails them.
		ready.catch(() => {});
		const current: NonNullable<typeof session> = { executable: install(message => ctx.ui.notify(message, "warning")), ready, settle, stop: new AbortController() };
		session = current;
		const settings: Promise<{ join?: string[]; attach?: string }> = existsSync(SETTINGS) ? readFile(SETTINGS, "utf8").then(JSON.parse) : Promise.resolve({});
		Promise.all([current.executable, settings]).then(
			([executable, { join: groups = [], attach }]) => {
				if (session !== current) return;
				// A new session, not the one a parent Pi's LETMEKNOW_SESSION names.
				const { LETMEKNOW_SESSION: _, ...env } = process.env;
				const stopped = (code: number | null, errors: string) => {
					current.settle.reject(new Error(`letmeknow stopped (exit ${code}): ${errors}`));
					if (session === current) ctx.ui.notify(`letmeknow stopped (exit ${code}): ${errors}`, "error");
				};
				// Runs `listen` or `attach`, `args`, with `program`: what it prints reaches the agent, and its `ready` names the session.
				const start = (program: string, args: string[], exited: typeof stopped) => {
					const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], env });
					current.listen = child;
					let errors = "";
					child.stderr!.on("data", chunk => (errors = (errors + chunk).slice(-2000)));
					child.on("error", error => ctx.ui.notify(`letmeknow: ${error.message}`, "error"));
					// One the update stopped stops nothing.
					child.on("exit", code => current.listen === child && exited(code, errors.trim()));
					createInterface({ input: child.stdout! }).on("line", line => {
						if (session !== current) return;
						const event = JSON.parse(line);
						if (event.type !== "ready") return wake(line);
						// An attached session's comes again as it runs again, with the program it runs then.
						current.fp = event.fp;
						current.bin = event.bin;
						current.log = event.log;
						current.attached = args.includes("attach");
						process.env.LETMEKNOW_SESSION = event.fp;
						current.settle.resolve(event.fp);
						ctx.ui.setStatus("letmeknow", `lmk:${event.fp}`);
						// One that ended meanwhile, or whose run an update stopped, stopped the join; its ctx may be stale.
						const { signal } = current.stop;
						joinListed(program, event.fp, groups, signal).then(
							warnings => !signal.aborted && warnings.forEach(warning => ctx.ui.notify(warning, "warning")),
							error => !signal.aborted && ctx.ui.notify(`letmeknow: joining the groups of ${SETTINGS}: ${error.message}`, "warning")
						);
					});
				};
				current.restart = (program, args) => start(program, args, stopped);
				if (!attach) return start(executable, ["listen"], stopped);
				// One that has a reader already, or does not run, leaves this Pi session a new letmeknow session.
				start(executable, ["--session", attach, "attach"], (code, errors) => {
					if (current.fp || session !== current) return stopped(code, errors);
					ctx.ui.notify(`letmeknow: not attached to ${attach} (${errors}); this Pi session is a new letmeknow session`, "info");
					start(executable, ["listen"], stopped);
				});
			},
			error => {
				current.settle.reject(error);
				ctx.ui.notify(`letmeknow: ${error.message}`, "error");
			}
		);
	});

	pi.on("before_agent_start", event => {
		if (!session) return;
		const fp = session.fp ? ` as its session ${session.fp}, as other members know it,` : "";
		const log = session.log ? ` it logs every event to ${session.log}, which you read at your own pace, and` : "";
		const attached = session.attached ? " It runs on beyond this Pi session, which attached to it: earlier Pi sessions may have spoken as it, and its log holds what they heard." : "";
		event.systemPromptOptions.sections.letmeknow = `You are in letmeknow${fp} in a session that runs already:${log} what concerns you reaches you as messages, and only what you send with it reaches anyone.${attached} Your letmeknow tool runs its commands; read \`skill\` with it before you first use letmeknow.`;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!session) return;
		const { listen, settle, stop } = session;
		session = undefined;
		settle.reject(new Error("this Pi session has left letmeknow"));
		// Stops a sibling run for a join, which would otherwise outlive Pi.
		stop.abort();
		clearTimeout(timer);
		waiting = [];
		delete claim.piLetmeknow;
		delete process.env.LETMEKNOW_SESSION;
		ctx.ui.setStatus("letmeknow", undefined);
		// One whose letmeknow had not started yet has nothing to stop; letmeknow deletes one that stops in no group.
		listen?.kill();
	});
}
