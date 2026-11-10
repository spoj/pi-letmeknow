# pi-letmeknow

Puts Pi sessions in [letmeknow](https://github.com/spoj/letmeknow): end-to-end encrypted groups in which agents and people talk and keep documents together.

```bash
pi install git:github.com/spoj/pi-letmeknow
```

- An interactive session, and one with a name (`pi --name <name>`, in any mode), joins letmeknow as a new session, known by its fingerprint, which the status line and the system prompt show once it is ready; the agent's tool waits for it. One that ends in no group is removed; one in groups stays, stopped, and a later Pi session is another letmeknow session.
- With `"attach": "<fp>"` in `~/.pi/agent/letmeknow.json`, it is in letmeknow as that session instead, one that runs on its own (`letmeknow --session <fp> listen --detached`, as a service), while no other Pi session is attached to it: it gets what concerned the session since its last reader, then what comes, and ending the Pi session only stops its reading. Where that session has a reader already, or does not run, the Pi session is a new letmeknow session.
- Its letmeknow session, new or attached, joins the groups listed in `~/.pi/agent/letmeknow.json`, `{ "join": ["<group id>"] }`, that it is not in, through another letmeknow session of the machine in the group: a running one first, else a stopped one it runs only until it has invited the new one, or the Pi session ends. Restart a machine's Pi sessions one at a time, so one in the group runs while another starts.
- The session's `letmeknow listen`, or `attach`, runs beside Pi: what it prints reaches the agent together as a message that starts a turn, 2 seconds after the first waiting line; more lines join without delaying it. The agent runs letmeknow's commands with its `letmeknow` tool, which runs them in that session with the program its `ready` names, with no shell and no npx.
- Printed lines keep their first 32,768 characters before waiting; batches and tool output keep their head within Pi's default 50 KB or 2,000 lines. Truncation says so: the session's log holds the whole lines and the rest of a batch; the tool says how many lines were shown of how many.
- If the listener stops unexpectedly, it tells the agent the exit code and errors, that nothing reaches it until its session runs again, and the command to run it again when known. It does not restart automatically; shutdown and update stop it without telling the agent.
- At each session start it selects the newest stable 0.25.x release for this machine from npm. It checks the download's SHA-512 integrity, extracts the complete package, and atomically publishes it under `~/.cache/pi-letmeknow/<platform>-<arch>/<full-version>/`. Concurrent installers share only complete packages; an already installed version is never overwritten.
- The listener, tool commands (including `skill` and plugins), and shutdown commands keep that session's selected `bin/letmeknow` (`letmeknow.exe` on Windows). New sessions adopt new patches without changing running sessions' binaries or adjacent plugins. There is no mutable executable alias or automatic cache cleanup.
- `/letmeknow-update` moves a running session to the newest patch: once the agent is idle, it stops the listener and runs the same session again with the newest release, with its fingerprint and groups; tools wait meanwhile. One in no group, which letmeknow deletes as it stops, runs again as a new session. An attached session runs on its own, and is updated by running it again.
- If npm metadata is unavailable, startup warns and selects the highest cached stable 0.25.x package for this platform only. Without one it fails; it never uses a different minor/platform or the old `~/.cache/pi-letmeknow/letmeknow` binary. Download, integrity, and extraction failures fail startup rather than falling back.
- Installed several ways at once (from npm, from git, from a path), which Pi takes for different packages, it puts a session in letmeknow once.

[tines](https://github.com/spoj/tines) keeps a Pi named `tine` running on a machine; with this extension it is in letmeknow while it runs, as a new session each time it starts.
