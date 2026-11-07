# Escadrille

Read docs/flot.md (the intended flow and its rules) and docs/sessions.md before coding. The docs are in French, the
code and its comments in English. Answer the developer in their language.

The goal, in order: more productivity on the developer's own projects, more serenity as a developer, and Claude
handling complex tasks with the fewest tokens. Every screen, plan and session is judged on that.

- Node 22.13+ and no dependency for the server (`node:http`, `node:sqlite`); a dependency is justified in one sentence
  before it is added. Port 3078.
- A session works in a worktree and its own branch; main moves only by merge.
- Planned sessions end every turn with an `escadrille:state` block (`docs/sessions.md`), which the server adds to
  their instructions and reads in the stream.
- Licence: MIT (`LICENSE`). No secret and no co-author line in a commit.
- No answer on the LAN without a device token (`docs/phone.md`); tokens, keys and push subscriptions are never
  committed; `phone/` has its own dependencies (Expo), the server has none.
- Show a screen with a `CAPTURE: <local url or .html>` line in the stop: never `open`, never a visible browser.
  The developer judges on images and pages, not descriptions: give paths or links.
- Every screen: one primary action, the secondary folded into one line, details on demand.
- Usage estimates follow `docs/estimation.md`.
- Never more than one question at a time to the developer: the most important one, recommendation first; the rest
  takes its recommendation by default or waits for the answer.
- A handoff lives in the worktree's `.escadrille/`, never committed.
- A plan states its budget (dollars, per session) and its network domains (`network`, empty by default; nothing the
  developer did not ask for).
- Nothing is pushed automatically: a push, a comment or a merge on GitHub only leaves from the developer's click in
  the app, never from a session, the pilot or a setting. Nothing is posted (PR, ticket comment, chat message)
  without the developer's yes.
- Nothing to production, no external service in the developer's name, nothing billed to them: everything stays local
  until they ask for it.
- The developer's decisions are in `docs/decisions.md`, dated: read it before proposing, add a line for each new one.
  A project's memory is `<project>/docs/decisions.md`, otherwise `<project>/.escadrille/memoire.md`; one line is
  added through `POST /api/memory` (`docs/multiproject.md`).
- An Escadrille rule never blocks a developer: a refusal gives the path that works, and a new developer's first use
  works without any setting.
- A file is changed with Edit or Write only, never with `sed -i`, a script or a heredoc.
- A network domain the plan does not declare is not asked again: do without and say so.
- Tests: `node --test test/*.test.mjs`. A test filter is passed as is (`--test-name-pattern Review`), and a run that
  executes no test counts as a failure.
