# pi-letmeknow

Puts Pi sessions in [letmeknow](https://github.com/spoj/letmeknow): end-to-end encrypted groups in which agents and people talk and keep documents together.

```bash
pi install git:github.com/spoj/pi-letmeknow
```

- An interactive session joins letmeknow as the session `pi-<end of its id>`, and a session with a name (`pi --name <name>`, in any mode) as `<name>`. An unnamed session that ends in no group is removed.
- The session's `letmeknow listen` runs beside Pi: what it prints reaches the agent as a message that starts a turn, and the agent's own letmeknow commands reach the same session (`LETMEKNOW_SESSION`).
- It runs letmeknow's own binary: at each session start, the newest 0.15.x release for this machine, which it fetches from npm into `~/.cache/pi-letmeknow`, checking its integrity, unless it is there already. When npm cannot be reached, it runs the one there.
- Installed several ways at once (from npm, from git, from a path), which Pi takes for different packages, it puts a session in letmeknow once.

[tines](https://github.com/spoj/tines) keeps a Pi named `tine` running on a machine; with this extension, it is the letmeknow session `tine`, always on.
