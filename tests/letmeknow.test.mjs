import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, beforeEach, mock, test } from "node:test";
import { promisify } from "node:util";
import { Type } from "typebox";
import { truncateHead } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js";

const run = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), "pi-letmeknow-test-"));
const target = `${process.platform}-${process.arch}`;
const cache = join(home, ".cache", "pi-letmeknow");
const executable = process.platform === "win32" ? "letmeknow.exe" : "letmeknow";
let versions, requests, calls, listeners, notices, offline, afterExtract, answer, refuse, stdout;
const archives = new Map();

mock.module("node:os", { namedExports: { homedir: () => home } });
mock.module("@earendil-works/pi-ai", { namedExports: { Type } });
mock.module("@earendil-works/pi-coding-agent", { namedExports: { defineTool: tool => tool, truncateHead } });
mock.module("node:child_process", {
	namedExports: {
		execFile: Object.assign(() => {}, {
			[promisify.custom]: (file, args, options) => {
				if (file === "tar") return run(file, args, options).then(afterExtract);
				const call = { file, args };
				calls.push(call);
				const running = (async () => {
					if (stdout !== undefined) return { stdout };
					if (answer) {
						const answered = await answer(args);
						if (answered instanceof Error) throw answered;
						return { stdout: JSON.stringify(answered) };
					}
					const version = await readFile(file, "utf8");
					const kind = await readFile(join(dirname(file), "kind"), "utf8");
					const skill = await readFile(join(dirname(file), "..", "skills", "SKILL.md"), "utf8");
					return { stdout: `${version}: ${kind}: ${skill}` };
				})();
				running.child = { stdin: { end: input => { call.input = input; } } };
				return running;
			},
		}),
		spawn: (file, args, options) => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
				kill: () => {
					if (child.killed) return false;
					child.killed = true;
					child.signalCode = "SIGTERM";
					setImmediate(() => child.emit("exit", null, "SIGTERM"));
					return true;
				},
			});
			// As Node does, an abort kills the child and emits an AbortError.
			options?.signal?.addEventListener("abort", () => {
				child.kill();
				child.emit("error", new Error("aborted"));
			});
			listeners.push({ file, args, child });
			const refused = refuse?.(args);
			if (refused) {
				child.stderr.write(refused);
				setImmediate(() => child.emit("exit", 1));
			} else {
				const fp = args[0] === "--session" ? args[1] : `${listeners.length}123456789abcdef`;
				child.stdout.write(`${JSON.stringify({ type: "ready", fp, bin: args.at(-1) === "attach" ? "/detached/letmeknow" : file })}\n`);
			}
			return child;
		},
	},
});
const { default: extension } = await import("../extensions/letmeknow.ts");

beforeEach(async () => {
	await rm(cache, { recursive: true, force: true });
	versions = {};
	requests = [];
	calls = [];
	listeners = [];
	notices = [];
	offline = false;
	afterExtract = () => {};
	answer = undefined;
	refuse = undefined;
	stdout = undefined;
	await rm(join(home, ".pi"), { recursive: true, force: true });
	delete globalThis.piLetmeknow;
	mock.method(globalThis, "fetch", async url => {
		requests.push(url);
		if (offline) throw new Error("offline");
		if (url === `https://registry.npmjs.org/@letmeknow/${target}`) return Response.json({ versions });
		assert.ok(archives.has(url), `unexpected fetch: ${url}`);
		return new Response(archives.get(url));
	});
});
after(async () => {
	mock.restoreAll();
	delete globalThis.piLetmeknow;
	delete process.env.LETMEKNOW_SESSION;
	await rm(home, { recursive: true });
});

async function release(version, plugins = { kind: `kind ${version}` }) {
	const source = await mkdtemp(join(home, "fixture-"));
	await mkdir(join(source, "package", "bin"), { recursive: true });
	await mkdir(join(source, "package", "skills"));
	await writeFile(join(source, "package", "package.json"), JSON.stringify({ version }));
	await writeFile(join(source, "package", "skills", "SKILL.md"), `skill ${version}`);
	for (const [name, value] of Object.entries({ [executable]: version, ...plugins })) {
		await writeFile(join(source, "package", "bin", name), value);
	}
	await run("tar", ["-czf", "package.tgz", "package"], { cwd: source });
	const bytes = await readFile(join(source, "package.tgz"));
	const tarball = `https://fixtures.invalid/${version}.tgz`;
	archives.set(tarball, bytes);
	versions[version] = { dist: { tarball, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } };
	return join(cache, target, version, "bin", executable);
}

const kept = fp => ({ type: "custom", customType: "letmeknow", data: { fp } });

// A Pi session whose file holds `entries`: those of an earlier run of it, for one that starts again.
function start(name = "named", mode = "tui", entries = []) {
	// Independent Pi processes have independent claims; emulate them around each factory's session state.
	delete globalThis.piLetmeknow;
	const handlers = {};
	const ready = Promise.withResolvers();
	let tool, status;
	const commands = {};
	const messages = [];
	const ctx = {
		cwd: home, mode, waitForIdle: async () => {},
		sessionManager: { getSessionName: () => name, getEntries: () => [...entries] },
		ui: {
			notify: (message, level) => {
				notices.push({ message, level });
				if (level === "error") ready.resolve(new Error(message));
			},
			setStatus: (_key, value) => { status = value; if (value) ready.resolve(); },
		},
	};
	extension({
		on: (event, handler) => { handlers[event] = handler; },
		registerTool: value => { tool = value; },
		registerCommand: (name, command) => { commands[name] = command; },
		sendMessage: (message, options) => { messages.push({ message, options }); },
		appendEntry: (customType, data) => { entries.push({ type: "custom", customType, data }); },
	});
	handlers.session_start({}, ctx);
	return {
		ready: ready.promise,
		messages,
		entries,
		messageStart: message => handlers.message_start({ message: { role: "custom", ...message } }),
		sessionStart: () => handlers.session_start({}, ctx),
		status: () => status,
		systemPrompt: () => {
			const event = { systemPromptOptions: { sections: {} } };
			handlers.before_agent_start(event);
			return event.systemPromptOptions.sections.letmeknow;
		},
		command: (args, input) => tool.execute("id", { args, input }, undefined, undefined, ctx),
		update: () => commands["letmeknow-update"].handler("", ctx),
		shutdown: (reason = "quit") => handlers.session_shutdown({ reason }, ctx),
	};
}

test("lines wake the agent 2 seconds after the first waiting line, even while more arrive", async t => {
	await release("0.26.2");
	const session = start();
	await session.ready;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { stdout } = listeners[0].child;
	for (let batch = 0; batch < 3; batch++) {
		stdout.write('{"type":"message","text":"first"}\n');
		t.mock.timers.tick(1500);
		stdout.write('{"type":"message","text":"second"}\n');
		t.mock.timers.tick(499);
		assert.equal(session.messages.length, batch);
		t.mock.timers.tick(1);
		assert.equal(session.messages.length, batch + 1);
		assert.deepEqual(session.messages[batch], {
			message: { customType: "letmeknow", display: true, content: [{ type: "text", text: '{"type":"message","text":"first"}\n{"type":"message","text":"second"}' }] },
			options: { deliverAs: "steer", triggerTurn: true },
		});
		session.messageStart(session.messages[batch].message);
	}
	await session.shutdown();
});

test("shutdown clears the wake timer and waiting lines before another session starts", async t => {
	await release("0.26.2");
	const session = start();
	await session.ready;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	listeners[0].child.stdout.write('{"type":"message","text":"old"}\n');
	await session.shutdown();
	t.mock.timers.tick(2000);
	assert.deepEqual(session.messages, []);
	session.sessionStart();
	await session.command(["skill"]);
	listeners[1].child.stdout.write('{"type":"message","text":"new"}\n');
	t.mock.timers.tick(2000);
	assert.equal(session.messages.length, 1);
	assert.deepEqual(session.messages[0].message.content, [{ type: "text", text: '{"type":"message","text":"new"}' }]);
	await session.shutdown();
});

for (const attached of [false, true]) {
	test(`an unexpectedly stopped ${attached ? "attach" : "listen"} tells the headless agent once, with the command to run it again`, async () => {
		const binary = await release("0.26.2");
		if (attached) {
			await mkdir(join(home, ".pi", "agent"), { recursive: true });
			await writeFile(join(home, ".pi", "agent", "letmeknow.json"), JSON.stringify({ attach: "fedcba9876543210" }));
		}
		const session = start("named", "headless");
		await session.ready;
		const { child } = listeners[0];
		child.stderr.write("first error\nlast error\n");
		child.emit("exit", 7);
		const fp = attached ? "fedcba9876543210" : "1123456789abcdef";
		const bin = attached ? "/detached/letmeknow" : binary;
		assert.deepEqual(session.messages, [{
			message: { customType: "letmeknow", display: true, content: [{ type: "text", text: `letmeknow stopped (exit 7): first error\nlast error\nNothing reaches you until it runs again: ${bin} --session ${fp} ${attached ? "attach" : "listen"}` }] },
			options: { deliverAs: "steer", triggerTurn: true },
		}]);
		assert.deepEqual(notices, [{ message: "letmeknow stopped (exit 7): first error\nlast error", level: "error" }]);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(listeners.length, 1, "the listener is not restarted automatically");
		await session.shutdown();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(session.messages.length, 1);
	});
}

test("a listener stopped before ready tells the agent without inventing a restart command", async () => {
	await release("0.26.2");
	refuse = () => "cannot start\n";
	const session = start("named", "headless");
	assert.match((await session.ready).message, /letmeknow stopped \(exit 1\): cannot start/);
	assert.equal(session.messages.length, 1);
	assert.deepEqual(session.messages[0].message.content, [{ type: "text", text: "letmeknow stopped (exit 1): cannot start\nNothing reaches you until it runs again." }]);
	await session.shutdown();
});

test("printed lines keep at most 12 Ki characters before waiting, with the whole line in the log", async t => {
	await release("0.26.2");
	const session = start();
	await session.ready;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const limit = 12 * 1024;
	const overhead = JSON.stringify({ type: "message", text: "" }).length;
	for (const size of [limit, limit + 1, 2 * 1024 * 1024]) {
		const line = JSON.stringify({ type: "message", text: "x".repeat(size - overhead) });
		listeners[0].child.stdout.write(`${line}\n`);
		t.mock.timers.tick(2000);
		const text = session.messages.at(-1).message.content[0].text;
		const expected = size > limit ? `${line.slice(0, limit)} [letmeknow: line truncated; the session's log has the whole line.]` : line;
		assert.equal(text.length, expected.length);
		assert.equal(text, expected);
		session.messageStart(session.messages.at(-1).message);
	}
	await session.shutdown();
});

for (const limit of ["bytes", "lines"]) {
	test(`wake batches use Pi's default ${limit} limit and point to the session's log`, async t => {
		await release("0.26.2");
		const session = start();
		await session.ready;
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const lines = limit === "bytes"
			? Array(3).fill(JSON.stringify({ type: "message", text: "é".repeat(10000) }))
			: Array(2001).fill('{"type":"event"}');
		listeners[0].child.stdout.write(`${lines.join("\n")}\n`);
		t.mock.timers.tick(2000);
		const output = truncateHead(lines.join("\n"));
		assert.equal(output.truncatedBy, limit);
		const expected = `${output.content}\n[letmeknow: output truncated; the rest is in the session's log.]`;
		const text = session.messages[0].message.content[0].text;
		assert.equal(text.length, expected.length);
		assert.equal(text, expected);
		await session.shutdown();
	});
}

test("tool stdout keeps its first 50,000 characters, one line or many, and says so only when truncated", async () => {
	await release("0.26.2");
	const session = start();
	await session.ready;
	for (const value of ["", "small\n", "x".repeat(50_000), "x".repeat(50_001), Array(9).fill("é".repeat(10000)).join("\n")]) {
		stdout = value;
		const expected = stdout.length > 50_000 ? `${stdout.slice(0, 50_000)}\n[letmeknow: output truncated; showing 50000 of ${stdout.length} characters.]` : stdout;
		const result = await session.command(["groups"]);
		assert.equal(result.content[0].text.length, expected.length);
		assert.deepEqual(result, { content: [{ type: "text", text: expected }], details: undefined });
	}
	await session.shutdown();
});

test("publishes the entire package at an immutable platform/full-version path and reuses it", async () => {
	await release("0.26.2");
	const binary = await release("0.26.10");
	await release("0.27.99");
	await release("0.26.11-beta.1");
	const first = start();
	assert.equal(await first.ready, undefined);
	assert.equal(listeners[0].file, binary);
	assert.equal(await readFile(join(dirname(binary), "..", "package.json"), "utf8"), '{"version":"0.26.10"}');
	assert.equal(await readFile(join(dirname(binary), "kind"), "utf8"), "kind 0.26.10");
	assert.equal(existsSync(join(cache, executable)), false);
	const second = start();
	assert.equal(await second.ready, undefined);
	assert.equal(listeners[1].file, binary);
	assert.equal(requests.filter(url => url.endsWith(".tgz")).length, 1);
	assert.deepEqual(await readdir(join(cache, target)), ["0.26.10"]);
});

test("new patch startup leaves old listener, skill, plugin and tool bound to their package", async () => {
	const oldBinary = await release("0.26.1", { kind: "old kind", retired: "retired plugin" });
	const old = start("");
	assert.equal(await old.ready, undefined);
	const newBinary = await release("0.26.2");
	const newer = start();
	assert.equal(await newer.ready, undefined);
	assert.deepEqual(listeners.map(item => item.file), [oldBinary, newBinary]);
	assert.deepEqual(listeners.map(item => item.args), [["listen"], ["listen"]], "each Pi session is a new letmeknow session");
	assert.equal(process.env.LETMEKNOW_SESSION, "2123456789abcdef");
	for (const args of [["skill"], ["kind", "read"], ["send", "--to", "someone", "-"]]) {
		assert.equal((await old.command(args, "input")).content[0].text, "0.26.1: old kind: skill 0.26.1");
		assert.equal(calls.at(-1).file, oldBinary);
		assert.deepEqual(calls.at(-1).args, ["--session", "1123456789abcdef", ...args]);
	}
	assert.equal((await newer.command(["skill"])).content[0].text, "0.26.2: kind 0.26.2: skill 0.26.2");
	assert.equal(await readFile(join(dirname(oldBinary), "retired"), "utf8"), "retired plugin");
	assert.equal(existsSync(join(dirname(newBinary), "retired")), false);
	const commands = calls.length;
	await old.shutdown();
	assert.deepEqual([listeners[0].child.killed, listeners[1].child.killed], [true, undefined]);
	await newer.shutdown();
	assert.equal(listeners[1].child.killed, true);
	assert.equal(calls.length, commands, "shutdown runs no command");
});

test("concurrent same-version installers publish only complete packages", async () => {
	const binary = await release("0.26.3");
	const extracted = Promise.withResolvers();
	let arrivals = 0;
	afterExtract = async () => {
		assert.equal(existsSync(binary), false);
		if (++arrivals === 2) extracted.resolve();
		await extracted.promise;
	};
	const first = start();
	const second = start();
	assert.deepEqual(await Promise.all([first.ready, second.ready]), [undefined, undefined]);
	assert.equal(arrivals, 2);
	assert.deepEqual(listeners.map(item => item.file), [binary, binary]);
	assert.equal(await readFile(join(dirname(binary), "kind"), "utf8"), "kind 0.26.3");
	assert.equal(await readFile(join(dirname(binary), "..", "skills", "SKILL.md"), "utf8"), "skill 0.26.3");
	assert.deepEqual(await readdir(join(cache, target)), ["0.26.3"]);
});

test("an older install finishing after a newer install cannot replace its package", async () => {
	const oldBinary = await release("0.26.4");
	const extracted = Promise.withResolvers();
	const resume = Promise.withResolvers();
	afterExtract = async () => { extracted.resolve(); await resume.promise; };
	const old = start();
	await extracted.promise;
	afterExtract = () => {};
	const newBinary = await release("0.26.5");
	const newer = start();
	assert.equal(await newer.ready, undefined);
	resume.resolve();
	assert.equal(await old.ready, undefined);
	assert.deepEqual(listeners.map(item => item.file), [newBinary, oldBinary]);
	assert.equal((await old.command(["skill"])).content[0].text, "0.26.4: kind 0.26.4: skill 0.26.4");
	assert.equal((await newer.command(["skill"])).content[0].text, "0.26.5: kind 0.26.5: skill 0.26.5");
});

test("the status line and system prompt give the session's fingerprint once it is ready", async () => {
	await release("0.26.8");
	const session = start();
	assert.doesNotMatch(session.systemPrompt(), /fingerprint/);
	assert.equal(await session.ready, undefined);
	assert.equal(session.status(), "lmk:1123456789abcdef");
	assert.match(session.systemPrompt(), /^You are in letmeknow as its session 1123456789abcdef, as other members know it, in a session that runs already:/);
});

test("/letmeknow-update runs the session again with the newest patch, as the same session, or a new one if it is in no group", async () => {
	const oldBinary = await release("0.26.18");
	const session = start();
	assert.equal(await session.ready, undefined);
	await session.update();
	assert.deepEqual(notices, [{ message: "letmeknow: 1123456789abcdef runs 0.26.18, the newest 0.26 release", level: "info" }]);
	assert.equal(listeners.length, 1);
	const newBinary = await release("0.26.19");
	answer = () => ({ groups: [{ group: "G1" }] });
	await session.update();
	answer = undefined;
	assert.equal(listeners[0].child.killed, true);
	assert.deepEqual(listeners.map(item => [item.file, item.args]), [[oldBinary, ["listen"]], [newBinary, ["--session", "1123456789abcdef", "listen"]]]);
	assert.equal((await session.command(["skill"])).content[0].text, "0.26.19: kind 0.26.19: skill 0.26.19");
	assert.deepEqual(calls.map(call => call.args), [["--session", "1123456789abcdef", "groups"], ["--session", "1123456789abcdef", "skill"]]);
	assert.equal(calls[0].file, oldBinary);
	assert.equal(session.status(), "lmk:1123456789abcdef");
	assert.deepEqual(notices.slice(1), [{ message: "letmeknow: 1123456789abcdef runs 0.26.19, updated from 0.26.18", level: "info" }]);
	const newest = await release("0.26.20");
	answer = () => ({});
	await session.update();
	assert.deepEqual([listeners[1].child.killed, listeners[2].file, listeners[2].args], [true, newest, ["listen"]]);
	await session.command(["groups"]);
	assert.deepEqual(calls.at(-1), { file: newest, args: ["--session", "3123456789abcdef", "groups"], input: "" });
	assert.equal(session.status(), "lmk:3123456789abcdef");
	assert.deepEqual(session.entries, [kept("1123456789abcdef"), kept("3123456789abcdef")]);
	assert.deepEqual(notices.slice(2), [{ message: "letmeknow: 3123456789abcdef runs 0.26.20, updated from 0.26.19", level: "info" }]);
	await session.shutdown();
	assert.equal(listeners[2].child.killed, true);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(session.messages, [], "update and shutdown stop listeners without telling the agent");
});

test("tools await selection, and shutdown during installation never launches a listener or command", async () => {
	const binary = await release("0.26.6");
	const extracted = Promise.withResolvers();
	const resume = Promise.withResolvers();
	afterExtract = async () => { extracted.resolve(); await resume.promise; };
	const session = start();
	const command = session.command(["skill"]);
	await extracted.promise;
	assert.equal(calls.length, 0);
	await session.shutdown();
	await assert.rejects(command, /has left letmeknow/);
	resume.resolve();
	// The installation goes on to publish the package.
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(listeners.length, 0);
	assert.equal(calls.length, 0);
	assert.equal(existsSync(binary), true);
});

test("a tool issued during startup waits for the selected binary", async () => {
	const binary = await release("0.26.7");
	const session = start();
	assert.equal((await session.command(["skill"])).content[0].text, "0.26.7: kind 0.26.7: skill 0.26.7");
	assert.equal(await session.ready, undefined);
	assert.equal(calls[0].file, binary);
});

test("offline startup selects the highest cached patch only in this minor and platform", async () => {
	await release("0.26.2");
	assert.equal(await start().ready, undefined);
	const binary = await release("0.26.10");
	assert.equal(await start().ready, undefined);
	for (const directory of [join(cache, target, "0.27.99"), join(cache, "other-platform", "0.26.99"), join(cache, target, "new-partial"), join(cache, target, "0.26.11-beta.1")]) {
		await mkdir(join(directory, "bin"), { recursive: true });
		await writeFile(join(directory, "bin", executable), "wrong binary");
	}
	await mkdir(join(cache, target, "0.26.100"));
	offline = true;
	const session = start();
	assert.equal(await session.ready, undefined);
	assert.equal(listeners.at(-1).file, binary);
	assert.match(notices.at(-1).message, /running cached 0\.26\.10/);
	assert.equal(notices.at(-1).level, "warning");
});

test("offline startup never reuses the legacy binary or another minor/platform", async () => {
	for (const directory of [join(cache, target, "0.25.99", "bin"), join(cache, target, "0.27.1", "bin"), join(cache, "other-platform", "0.26.99", "bin"), cache]) {
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, executable), "legacy or unsupported");
	}
	offline = true;
	const session = start();
	assert.match((await session.ready).message, /offline/);
	await assert.rejects(session.command(["skill"]), /offline/);
	assert.equal(listeners.length, 0);
	assert.equal(calls.length, 0);
});

test("integrity failure does not publish or fall back to a cached patch", async () => {
	await release("0.26.1");
	assert.equal(await start().ready, undefined);
	const binary = await release("0.26.2");
	versions["0.26.2"].dist.integrity = "sha512-wrong";
	const session = start();
	assert.match((await session.ready).message, /does not match its integrity/);
	await assert.rejects(session.command(["skill"]), /does not match its integrity/);
	assert.equal(existsSync(binary), false);
	assert.equal(listeners.length, 1);
	assert.deepEqual(await readdir(join(cache, target)), ["0.26.1"]);
});

test("download failure does not fall back to an older cached patch", async () => {
	await release("0.26.1");
	assert.equal(await start().ready, undefined);
	const binary = await release("0.26.2");
	mock.method(globalThis, "fetch", async url => url.endsWith(".tgz")
		? new Response("unavailable", { status: 503 }) : Response.json({ versions }));
	const session = start();
	assert.match((await session.ready).message, /cannot fetch letmeknow 0\.26\.2 \(503\)/);
	assert.equal(existsSync(binary), false);
	assert.equal(listeners.length, 1);
	assert.deepEqual(await readdir(join(cache, target)), ["0.26.1"]);
});

test("publication failure is not mistaken for a concurrent completed install", async () => {
	const binary = await release("0.26.9");
	await mkdir(join(cache, target), { recursive: true });
	await writeFile(join(cache, target, "0.26.9"), "not a package directory");
	const session = start();
	assert.ok(await session.ready instanceof Error);
	assert.equal(existsSync(binary), false);
	assert.equal(listeners.length, 0);
	assert.deepEqual(await readdir(join(cache, target)), ["0.26.9"]);
	assert.equal(await readFile(join(cache, target, "0.26.9"), "utf8"), "not a package directory");
});

test("failed extraction cleans staging without publishing a partial package", async () => {
	const binary = await release("0.26.8");
	const { dist } = versions["0.26.8"];
	const bytes = Buffer.from("not a tarball");
	archives.set(dist.tarball, bytes);
	dist.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	const session = start();
	assert.ok(await session.ready instanceof Error);
	assert.equal(existsSync(binary), false);
	assert.deepEqual(await readdir(join(cache, target)), []);
	assert.equal(listeners.length, 0);
});

test("a new session joins the listed groups it is not in, through a running sibling first, else a stopped one it runs meanwhile", async () => {
	await release("0.26.9");
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "letmeknow.json"), JSON.stringify({ join: ["G1", "G2", "G3"] }));
	const joined = Promise.withResolvers();
	answer = args => {
		if (args[0] === "sessions") return { sessions: [
			{ fp: "stopped", groups: ["G1", "G2"] },
			{ fp: "running", running: true, groups: ["G1"] },
		] };
		if (args[2] === "invite") return { link: `link-${args[1]}-${args[4]}` };
		if (args[2] === "join" && args[3] === "link-stopped-G2") joined.resolve();
		return {};
	};
	const session = start();
	await session.ready;
	await joined.promise;
	const commands = calls.map(call => call.args.join(" ")).filter(args => !args.endsWith(" listen"));
	const me = "1123456789abcdef";
	assert.deepEqual(commands, [
		"sessions",
		"--session running invite --group G1", `--session ${me} join link-running-G1`,
		"--session stopped invite --group G2", `--session ${me} join link-stopped-G2`,
	]);
	assert.deepEqual(listeners.map(item => item.args.join(" ")), ["listen", "--session stopped listen"]);
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(listeners[1].child.killed, true);
	assert.deepEqual(notices.filter(n => n.level === "warning").map(n => n.message), ["letmeknow: cannot join G3 through a session of this machine"]);
	await session.shutdown();
});

test("a Pi session attaches to the session letmeknow.json names, as its reader, and runs its commands with that session's program", async () => {
	await release("0.26.13");
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "letmeknow.json"), JSON.stringify({ attach: "fedcba9876543210" }));
	answer = () => ({});
	const session = start();
	assert.equal(await session.ready, undefined);
	assert.deepEqual(listeners.map(item => item.args), [["--session", "fedcba9876543210", "attach"]]);
	assert.equal(session.status(), "lmk:fedcba9876543210");
	assert.match(session.systemPrompt(), /^You are in letmeknow as its session fedcba9876543210,.* It runs on beyond this Pi session, which attached to it:/);
	await session.command(["groups"]);
	assert.deepEqual(calls, [{ file: "/detached/letmeknow", args: ["--session", "fedcba9876543210", "groups"], input: "" }]);
	// Run again, maybe by a newer program, the session says so in a new `ready`.
	listeners[0].child.stdout.write(`${JSON.stringify({ type: "ready", fp: "fedcba9876543210", bin: "/detached/newer" })}\n`);
	await new Promise(resolve => setTimeout(resolve, 10));
	await session.command(["groups"]);
	assert.equal(calls.at(-1).file, "/detached/newer");
	assert.deepEqual(session.entries, [kept("fedcba9876543210")]);
	await session.update();
	assert.equal(listeners.length, 1, "one that runs on its own is updated by running it again");
	assert.match(notices.at(-1).message, /fedcba9876543210 runs on its own/);
	await session.shutdown();
	assert.equal(listeners[0].child.killed, true, "ending the Pi session only stops its reading");
});

test("a Pi session whose session to attach to has a reader already is a new letmeknow session", async () => {
	await release("0.26.13");
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "letmeknow.json"), JSON.stringify({ attach: "fedcba9876543210" }));
	refuse = args => args.at(-1) === "attach" && "letmeknow: session fedcba9876543210 has a reader attached already\n";
	const session = start();
	assert.equal(await session.ready, undefined);
	assert.deepEqual(listeners.map(item => item.args), [["--session", "fedcba9876543210", "attach"], ["listen"]]);
	assert.equal(session.status(), "lmk:2123456789abcdef");
	assert.doesNotMatch(session.systemPrompt(), /attached/);
	assert.deepEqual(notices.map(n => n.level), ["info"]);
	assert.match(notices[0].message, /not attached to fedcba9876543210 \(letmeknow: session fedcba9876543210 has a reader attached already\)/);
	await session.shutdown();
	assert.equal(listeners[1].child.killed, true);
});

test("a Pi session keeps its letmeknow session's fingerprint, and one that starts again is that session once its last run stopped", async () => {
	await release("0.26.2");
	const first = start();
	await first.ready;
	assert.deepEqual(first.entries, [kept("1123456789abcdef")]);
	let exited = false;
	listeners[0].child.once("exit", () => { exited = true; });
	await first.shutdown("reload");
	assert.equal(exited, true, "the session that a reload starts next runs the same letmeknow session, which one process runs");
	const again = start("named", "tui", first.entries);
	await again.ready;
	assert.deepEqual(listeners.map(item => item.args), [["listen"], ["--session", "1123456789abcdef", "listen"]]);
	assert.equal(again.status(), "lmk:1123456789abcdef");
	assert.deepEqual(again.entries, [kept("1123456789abcdef")]);
	exited = false;
	listeners[1].child.once("exit", () => { exited = true; });
	await again.shutdown();
	assert.deepEqual([listeners[1].child.killed, exited], [true, false], "a Pi that quits does not wait for it");
	assert.deepEqual(notices, []);
});

test("a Pi session whose letmeknow session does not run again is a new one, and keeps that one's fingerprint", async () => {
	await release("0.26.2");
	refuse = args => args[0] === "--session" && "letmeknow: this session is already running\n";
	const session = start("named", "tui", [kept("0000000000000000"), kept("aaaaaaaaaaaaaaaa")]);
	await session.ready;
	assert.deepEqual(listeners.map(item => item.args), [["--session", "aaaaaaaaaaaaaaaa", "listen"], ["listen"]]);
	assert.deepEqual(notices, [{ message: "letmeknow: not aaaaaaaaaaaaaaaa again (letmeknow: this session is already running)", level: "info" }]);
	assert.equal(session.status(), "lmk:2123456789abcdef");
	assert.deepEqual(session.entries.slice(2), [kept("2123456789abcdef")]);
	await session.shutdown();
});

test("a Pi session is the letmeknow session it was before the one letmeknow.json names to attach to, which it attaches to if it was that one", async () => {
	await release("0.26.2");
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "letmeknow.json"), JSON.stringify({ attach: "fedcba9876543210" }));
	const own = start("named", "tui", [kept("aaaaaaaaaaaaaaaa")]);
	await own.ready;
	await own.shutdown();
	const attached = start("named", "tui", [kept("fedcba9876543210")]);
	await attached.ready;
	await attached.shutdown();
	assert.deepEqual(listeners.map(item => item.args), [["--session", "aaaaaaaaaaaaaaaa", "listen"], ["--session", "fedcba9876543210", "attach"]]);
	assert.deepEqual(notices, []);
	refuse = args => args[0] === "--session" && "refused\n";
	const neither = start("named", "tui", [kept("aaaaaaaaaaaaaaaa")]);
	await neither.ready;
	assert.deepEqual(listeners.slice(2).map(item => item.args), [["--session", "aaaaaaaaaaaaaaaa", "listen"], ["--session", "fedcba9876543210", "attach"], ["listen"]]);
	assert.deepEqual(notices.map(n => n.message), ["letmeknow: not aaaaaaaaaaaaaaaa again (refused)", "letmeknow: not attached to fedcba9876543210 (refused); this Pi session is a new letmeknow session"]);
	assert.deepEqual(neither.entries.at(-1), kept("5123456789abcdef"));
	await neither.shutdown();
});

test("a Pi session that ends during a join stops the sibling it runs meanwhile, and joins no further", async () => {
	await release("0.26.9");
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "letmeknow.json"), JSON.stringify({ join: ["G1", "G2"] }));
	const inviting = Promise.withResolvers();
	const invite = Promise.withResolvers();
	answer = args => {
		if (args[0] === "sessions") return { sessions: [{ fp: "stopped", groups: ["G1", "G2"] }] };
		inviting.resolve();
		return invite.promise;
	};
	const session = start();
	await session.ready;
	await inviting.promise;
	await session.shutdown();
	assert.deepEqual(listeners.map(item => [item.args.join(" "), item.child.killed]), [["listen", true], ["--session stopped listen", true]]);
	invite.reject(Object.assign(new Error("failed"), { stderr: "letmeknow: session stopped is not running" }));
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(calls.map(call => call.args.join(" ")), ["sessions", "--session stopped invite --group G1"]);
	assert.equal(listeners.length, 2);
	assert.deepEqual(notices, []);
});

test("/letmeknow-update during a join stops it and the sibling it runs, and the new run joins again", async () => {
	await release("0.26.9");
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "letmeknow.json"), JSON.stringify({ join: ["G1"] }));
	const inviting = Promise.withResolvers();
	const invite = Promise.withResolvers();
	const joined = Promise.withResolvers();
	let invites = 0;
	answer = args => {
		if (args[0] === "sessions") return { sessions: [{ fp: "stopped", groups: ["G1"] }] };
		if (args[2] === "invite" && ++invites === 1) {
			inviting.resolve();
			return invite.promise;
		}
		if (args[2] === "invite") return { link: "link-2" };
		if (args[2] === "join") joined.resolve();
		return {};
	};
	const session = start();
	await session.ready;
	await inviting.promise;
	await release("0.26.10");
	await session.update();
	await joined.promise;
	assert.deepEqual(listeners.map(item => [item.args.join(" "), item.child.killed]), [
		["listen", true], ["--session stopped listen", true], ["listen", undefined], ["--session stopped listen", undefined],
	]);
	invite.reject(Object.assign(new Error("failed"), { stderr: "letmeknow: session stopped is not running" }));
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(calls.map(call => call.args.join(" ")).filter(args => args.includes("join")), ["--session 3123456789abcdef join link-2"]);
	assert.deepEqual(notices.filter(n => n.level !== "info"), []);
	await session.shutdown();
});
