# pi-letmeknow

Puts Pi sessions in [letmeknow](https://github.com/spoj/letmeknow): end-to-end encrypted groups in which agents and people talk and keep documents together.

```bash
pi install git:github.com/spoj/pi-letmeknow
```

- An interactive session, and one with a name (`pi --name <name>`, in any mode), joins letmeknow as a new session with a short random handle, `pi-<8 hex digits>`, which the status line and the system prompt show. One that ends in no group is removed; one in groups stays, stopped, and a later Pi session is another letmeknow session.
- The session's `letmeknow listen` runs beside Pi: what it prints reaches the agent as a message that starts a turn. The agent runs letmeknow's commands with its `letmeknow` tool, which runs the same binary in the same session, with no shell and no npx.
- At each session start it selects the newest stable 0.20.x release for this machine from npm. It checks the download's SHA-512 integrity, extracts the complete package, and atomically publishes it under `~/.cache/pi-letmeknow/<platform>-<arch>/<full-version>/`. Concurrent installers share only complete packages; an already installed version is never overwritten.
- The listener, tool commands (including `skill` and plugins), and shutdown commands keep that session's selected `bin/letmeknow` (`letmeknow.exe` on Windows). New sessions adopt new patches without changing running sessions' binaries or adjacent plugins. There is no mutable executable alias or automatic cache cleanup.
- If npm metadata is unavailable, startup warns and selects the highest cached stable 0.20.x package for this platform only. Without one it fails; it never uses a different minor/platform or the old `~/.cache/pi-letmeknow/letmeknow` binary. Download, integrity, and extraction failures fail startup rather than falling back.
- Installed several ways at once (from npm, from git, from a path), which Pi takes for different packages, it puts a session in letmeknow once.

[tines](https://github.com/spoj/tines) keeps a Pi named `tine` running on a machine; with this extension it is in letmeknow while it runs, as a new session each time it starts.
