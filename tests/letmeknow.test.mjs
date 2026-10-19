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

const run = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), "pi-letmeknow-test-"));
const target = `${process.platform}-${process.arch}`;
const cache = join(home, ".cache", "pi-letmeknow");
const executable = process.platform === "win32" ? "letmeknow.exe" : "letmeknow";
let versions, requests, calls, listeners, notices, groups, offline, afterExtract;
const archives = new Map();

mock.module("node:os", { namedExports: { homedir: () => home } });
mock.module("@earendil-works/pi-ai", { namedExports: { Type } });
mock.module("@earendil-works/pi-coding-agent", { namedExports: { defineTool: tool => tool } });
mock.module("node:child_process", {
	namedExports: {
		execFile: Object.assign(() => {}, {
			[promisify.custom]: (file, args, options) => {
				if (file === "tar") return run(file, args, options).then(afterExtract);
				const call = { file, args };
				calls.push(call);
				const running = (async () => {
					const version = await readFile(file, "utf8");
					if (args[0] === "sessions") return { stdout: JSON.stringify({ sessions: groups }) };
					const kind = await readFile(join(dirname(file), "kind"), "utf8");
					const skill = await readFile(join(dirname(file), "..", "skills", "SKILL.md"), "utf8");
					return { stdout: `${version}: ${kind}: ${skill}` };
				})();
				running.child = { stdin: { end: input => { call.input = input; } } };
				return running;
			},
		}),
		spawn: (file, args) => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(), stderr: new PassThrough(),
				kill: () => { child.killed = true; },
			});
			listeners.push({ file, args, child });
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
	groups = [];
	offline = false;
	afterExtract = () => {};
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

function start(name = "named") {
	// Independent Pi processes have independent claims; emulate them around each factory's session state.
	delete globalThis.piLetmeknow;
	const handlers = {};
	const ready = Promise.withResolvers();
	let tool;
	const ctx = {
		cwd: home, mode: "tui",
		sessionManager: { getSessionName: () => name },
		ui: {
			notify: (message, level) => {
				notices.push({ message, level });
				if (level === "error") ready.resolve(new Error(message));
			},
			setStatus: (_key, value) => { if (value) ready.resolve(); },
		},
	};
	extension({ on: (event, handler) => { handlers[event] = handler; }, registerTool: value => { tool = value; } });
	handlers.session_start({}, ctx);
	return {
		ready: ready.promise,
		command: (args, input) => tool.execute("id", { args, input }, undefined, undefined, ctx),
		shutdown: () => handlers.session_shutdown({}, ctx),
	};
}

test("publishes the entire package at an immutable platform/full-version path and reuses it", async () => {
	await release("0.22.2");
	const binary = await release("0.22.10");
	await release("0.23.99");
	await release("0.22.11-beta.1");
	const first = start();
	assert.equal(await first.ready, undefined);
	assert.equal(listeners[0].file, binary);
	assert.equal(await readFile(join(dirname(binary), "..", "package.json"), "utf8"), '{"version":"0.22.10"}');
	assert.equal(await readFile(join(dirname(binary), "kind"), "utf8"), "kind 0.22.10");
	assert.equal(existsSync(join(cache, executable)), false);
	const second = start();
	assert.equal(await second.ready, undefined);
	assert.equal(listeners[1].file, binary);
	assert.equal(requests.filter(url => url.endsWith(".tgz")).length, 1);
	assert.deepEqual(await readdir(join(cache, target)), ["0.22.10"]);
});

test("new patch startup leaves old listener, skill, plugin, tool and shutdown bound to their package", async () => {
	const oldBinary = await release("0.22.1", { kind: "old kind", retired: "retired plugin" });
	const old = start("");
	assert.equal(await old.ready, undefined);
	const newBinary = await release("0.22.2");
	const newer = start();
	assert.equal(await newer.ready, undefined);
	assert.deepEqual(listeners.map(item => item.file), [oldBinary, newBinary]);
	const [handle, other] = listeners.map(item => item.args[1]);
	assert.match(handle, /^pi-[0-9a-f]{8}$/);
	assert.notEqual(handle, other, "each Pi session is a new letmeknow session");
	for (const args of [["skill"], ["kind", "read"], ["send", "--to", "someone", "-"]]) {
		assert.equal((await old.command(args, "input")).content[0].text, "0.22.1: old kind: skill 0.22.1");
		assert.equal(calls.at(-1).file, oldBinary);
		assert.deepEqual(calls.at(-1).args, ["--session", handle, ...args]);
	}
	assert.equal((await newer.command(["skill"])).content[0].text, "0.22.2: kind 0.22.2: skill 0.22.2");
	assert.equal(await readFile(join(dirname(oldBinary), "retired"), "utf8"), "retired plugin");
	assert.equal(existsSync(join(dirname(newBinary), "retired")), false);
	groups = [{ handle, groups: [] }, { handle: other, groups: ["a group"] }];
	await old.shutdown();
	assert.equal(listeners[0].child.killed, true);
	assert.deepEqual(calls.slice(-2).map(({ file, args }) => ({ file, args })), [
		{ file: oldBinary, args: ["sessions"] },
		{ file: oldBinary, args: ["sessions", "remove", handle] },
	]);
	await newer.shutdown();
	assert.deepEqual(calls.at(-1), { file: newBinary, args: ["sessions"] }, "one in a group stays");
	assert.equal(listeners[1].child.killed, true);
});

test("concurrent same-version installers publish only complete packages", async () => {
	const binary = await release("0.22.3");
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
	assert.equal(await readFile(join(dirname(binary), "kind"), "utf8"), "kind 0.22.3");
	assert.equal(await readFile(join(dirname(binary), "..", "skills", "SKILL.md"), "utf8"), "skill 0.22.3");
	assert.deepEqual(await readdir(join(cache, target)), ["0.22.3"]);
});

test("an older install finishing after a newer install cannot replace its package", async () => {
	const oldBinary = await release("0.22.4");
	const extracted = Promise.withResolvers();
	const resume = Promise.withResolvers();
	afterExtract = async () => { extracted.resolve(); await resume.promise; };
	const old = start();
	await extracted.promise;
	afterExtract = () => {};
	const newBinary = await release("0.22.5");
	const newer = start();
	assert.equal(await newer.ready, undefined);
	resume.resolve();
	assert.equal(await old.ready, undefined);
	assert.deepEqual(listeners.map(item => item.file), [newBinary, oldBinary]);
	assert.equal((await old.command(["skill"])).content[0].text, "0.22.4: kind 0.22.4: skill 0.22.4");
	assert.equal((await newer.command(["skill"])).content[0].text, "0.22.5: kind 0.22.5: skill 0.22.5");
});

test("tools await selection, and shutdown during installation never launches a listener or command", async () => {
	const binary = await release("0.22.6");
	const extracted = Promise.withResolvers();
	const resume = Promise.withResolvers();
	afterExtract = async () => { extracted.resolve(); await resume.promise; };
	const session = start();
	const command = session.command(["skill"]);
	await extracted.promise;
	assert.equal(calls.length, 0);
	await session.shutdown();
	resume.resolve();
	await assert.rejects(command, /has left letmeknow/);
	assert.equal(listeners.length, 0);
	assert.equal(calls.length, 0);
	assert.equal(existsSync(binary), true);
});

test("a tool issued during startup waits for the selected binary", async () => {
	const binary = await release("0.22.7");
	const session = start();
	assert.equal((await session.command(["skill"])).content[0].text, "0.22.7: kind 0.22.7: skill 0.22.7");
	assert.equal(await session.ready, undefined);
	assert.equal(calls[0].file, binary);
});

test("offline startup selects the highest cached patch only in this minor and platform", async () => {
	await release("0.22.2");
	assert.equal(await start().ready, undefined);
	const binary = await release("0.22.10");
	assert.equal(await start().ready, undefined);
	for (const directory of [join(cache, target, "0.23.99"), join(cache, "other-platform", "0.22.99"), join(cache, target, "new-partial"), join(cache, target, "0.22.11-beta.1")]) {
		await mkdir(join(directory, "bin"), { recursive: true });
		await writeFile(join(directory, "bin", executable), "wrong binary");
	}
	await mkdir(join(cache, target, "0.22.100"));
	offline = true;
	const session = start();
	assert.equal(await session.ready, undefined);
	assert.equal(listeners.at(-1).file, binary);
	assert.match(notices.at(-1).message, /running cached 0\.22\.10/);
	assert.equal(notices.at(-1).level, "warning");
});

test("offline startup never reuses the legacy binary or another minor/platform", async () => {
	for (const directory of [join(cache, target, "0.21.99", "bin"), join(cache, target, "0.23.1", "bin"), join(cache, "other-platform", "0.22.99", "bin"), cache]) {
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
	await release("0.22.1");
	assert.equal(await start().ready, undefined);
	const binary = await release("0.22.2");
	versions["0.22.2"].dist.integrity = "sha512-wrong";
	const session = start();
	assert.match((await session.ready).message, /does not match its integrity/);
	await assert.rejects(session.command(["skill"]), /does not match its integrity/);
	assert.equal(existsSync(binary), false);
	assert.equal(listeners.length, 1);
	assert.deepEqual(await readdir(join(cache, target)), ["0.22.1"]);
});

test("download failure does not fall back to an older cached patch", async () => {
	await release("0.22.1");
	assert.equal(await start().ready, undefined);
	const binary = await release("0.22.2");
	mock.method(globalThis, "fetch", async url => url.endsWith(".tgz")
		? new Response("unavailable", { status: 503 }) : Response.json({ versions }));
	const session = start();
	assert.match((await session.ready).message, /cannot fetch letmeknow 0\.22\.2 \(503\)/);
	assert.equal(existsSync(binary), false);
	assert.equal(listeners.length, 1);
	assert.deepEqual(await readdir(join(cache, target)), ["0.22.1"]);
});

test("publication failure is not mistaken for a concurrent completed install", async () => {
	const binary = await release("0.22.9");
	await mkdir(join(cache, target), { recursive: true });
	await writeFile(join(cache, target, "0.22.9"), "not a package directory");
	const session = start();
	assert.ok(await session.ready instanceof Error);
	assert.equal(existsSync(binary), false);
	assert.equal(listeners.length, 0);
	assert.deepEqual(await readdir(join(cache, target)), ["0.22.9"]);
	assert.equal(await readFile(join(cache, target, "0.22.9"), "utf8"), "not a package directory");
});

test("failed extraction cleans staging without publishing a partial package", async () => {
	const binary = await release("0.22.8");
	const { dist } = versions["0.22.8"];
	const bytes = Buffer.from("not a tarball");
	archives.set(dist.tarball, bytes);
	dist.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	const session = start();
	assert.ok(await session.ready instanceof Error);
	assert.equal(existsSync(binary), false);
	assert.deepEqual(await readdir(join(cache, target)), []);
	assert.equal(listeners.length, 0);
});
