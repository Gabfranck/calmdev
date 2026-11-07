# Contributing

## Run it

```sh
./run.sh                        # http://localhost:3078 (./run.sh --lan opens the LAN, for the phone)
node --test 'test/*.test.mjs'   # the tests run against a fake claude, no network, no payment
```

## Rules that matter

- No server-side dependency without one sentence that justifies it. The server is Node 22.13+
  (`node:http`, `node:sqlite`) and nothing else; `phone/` has its own dependencies (Expo).
- One session, one worktree, one branch. `main` moves only by merge.
- No co-author line in commits. Commit messages in English.
- Docs in French, code in English.
- Nothing that calls an external service, publishes, or bills anyone: everything stays local.

## Read before writing

`CLAUDE.md`, then [`docs/flot.md`](docs/flot.md) (the intended flow and the rules),
[`docs/sessions.md`](docs/sessions.md) and [`docs/decisions.md`](docs/decisions.md).

Decisions go in `docs/decisions.md`, one dated line each, the latest at the bottom.

## The install firewall

A plain install (a clone of the official repository) never plans nor launches a session on calmdev itself: the
server answers 403 and says to fork (`lib/selfedit.mjs`). A fork, a checkout without `origin`, a file
`~/.config/escadrille/maintainer` or `ESCADRILLE_SELF_EDIT=1` lift it. A soft firewall, not a security boundary.
