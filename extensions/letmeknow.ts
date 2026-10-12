// Puts a Pi session in letmeknow: an interactive one, and any with a name (`pi --name <name>`), as the letmeknow session
// of that name, or else `pi-<end of its id>`, which goes when the Pi session ends in no group. It runs letmeknow's own
// binary, the newest release of the minor version it speaks, which it fetches from npm into ~/.cache/pi-letmeknow. What
// the letmeknow session prints reaches the agent as a message that starts a turn; its `ready` only names the session,
// which the system prompt and status line show.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MINOR = "0.14";
/** letmeknow's binary, and the kinds' plugins it runs from beside it. */
const BIN = join(homedir(), ".cache", "pi-letmeknow");
const LETMEKNOW = join(BIN, process.platform === "win32" ? "letmeknow.exe" : "letmeknow");
const run = promisify(execFile);
// Pi loads a package once, but from npm, from git and from a path this extension is three packages: of the copies a Pi
// process loads, the first to start a session puts it in letmeknow, until that session ends.
const claim = globalThis as { piLetmeknow?: true };

/** Puts the newest release of letmeknow MINOR for this machine into BIN, from npm, unless it is there already. */
async function update(): Promise<void> {
	// Termux's node says android; the static Linux binaries run there.
	const target = `${process.platform === "android" ? "linux" : process.platform}-${process.arch}`;
	const found = await fetch(`https://registry.npmjs.org/@letmeknow/${target}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
	if (!found.ok) throw new Error(`npm has no @letmeknow/${target} (${found.status})`);
	const { versions } = (await found.json()) as { versions: Record<string, { dist: { tarball: string; integrity: string } }> };
	const patch = (version: string) => Number(version.split(".")[2]);
	const latest = Object.keys(versions)
		.filter(version => version.startsWith(`${MINOR}.`) && /^\d+\.\d+\.\d+$/.test(version))
		.sort((a, b) => patch(a) - patch(b))
		.at(-1);
	if (!latest) throw new Error(`letmeknow has no ${MINOR} release for ${target}`);
	if (existsSync(LETMEKNOW) && (await run(LETMEKNOW, ["--version"])).stdout.trim() === `letmeknow ${latest}`) return;
	const { tarball, integrity } = versions[latest].dist;
	const fetched = await fetch(tarball);
	if (!fetched.ok) throw new Error(`cannot fetch letmeknow ${latest} (${fetched.status})`);
	const bytes = Buffer.from(await fetched.arrayBuffer());
	if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) throw new Error(`letmeknow ${latest} does not match its integrity`);
	await mkdir(BIN, { recursive: true });
	const tmp = await mkdtemp(join(BIN, "new-"));
	await writeFile(join(tmp, "package.tgz"), bytes);
	await run("tar", ["-xzf", join(tmp, "package.tgz"), "-C", tmp]);
	const files = await readdir(join(tmp, "package", "bin"));
	for (const file of await readdir(BIN)) {
		// What the last release had and this one has not, as a kind's plugin it dropped, which letmeknow would run, as it
		// runs every plugin beside it but those with a '.' in their names.
		if (!files.includes(file) && !file.endsWith(".old") && !file.startsWith("new-")) await rename(join(BIN, file), join(BIN, `${file}.${Date.now()}.old`));
	}
	for (const file of files) {
		const dest = join(BIN, file);
		// Windows cannot replace a program that runs, but can move it aside.
		if (process.platform === "win32" && existsSync(dest)) await rename(dest, `${dest}.${Date.now()}.old`);
		await rename(join(tmp, "package", "bin", file), dest);
	}
	await rm(tmp, { recursive: true });
	for (const file of await readdir(BIN)) {
		// What this or an earlier update moved aside; on Windows, one that still runs goes at a later update.
		if (file.endsWith(".old")) await rm(join(BIN, file)).catch(() => {});
	}
}

export default function (pi: ExtensionAPI): void {
	let session: { handle: string; removable: boolean; listen?: ChildProcess } | undefined;
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
		if ((!name && ctx.mode !== "tui") || claim.piLetmeknow) return;
		claim.piLetmeknow = true;
		// A letmeknow handle has letters, digits, '.', '_' and '-'.
		const handle = name ? name.replace(/[^\w.-]+/g, "-") : `pi-${ctx.sessionManager.getSessionId().slice(-12)}`;
		const current: NonNullable<typeof session> = { handle, removable: !name };
		session = current;
		process.env.LETMEKNOW_SESSION = handle;
		const ready = update().catch(error => {
			if (!existsSync(LETMEKNOW)) throw error;
			ctx.ui.notify(`letmeknow: cannot look for a newer ${MINOR} release (${error.message}); running the one here`, "warning");
		});
		ready.then(
			() => {
				if (session !== current) return;
				const listen = spawn(LETMEKNOW, ["--session", handle, "listen"], { stdio: ["ignore", "pipe", "pipe"] });
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
		event.systemPromptOptions.sections.letmeknow = `You are in letmeknow as its session ${session.handle}, which runs already: what it prints reaches you as messages, and only what you send with it reaches anyone. Read \`npx -y @letmeknow/cli@${MINOR} skill\` before you first use letmeknow.`;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!session) return;
		const { handle, removable, listen } = session;
		session = undefined;
		delete claim.piLetmeknow;
		delete process.env.LETMEKNOW_SESSION;
		ctx.ui.setStatus("letmeknow", undefined);
		// One whose letmeknow had not started yet has nothing to stop.
		if (!listen) return;
		const { sessions } = JSON.parse((await run(LETMEKNOW, ["sessions"])).stdout) as { sessions: { handle: string; groups: unknown[] }[] };
		if (removable && sessions.some(s => s.handle === handle && !s.groups.length)) await run(LETMEKNOW, ["sessions", "remove", handle]);
		else listen.kill();
	});
}
