// Escadrille: one small server, no dependency (node:http, node:sqlite, Node 22.13+), on port 3078.
//   node --no-warnings server.mjs
// It keeps, in a SQLite file:
//   - the escadrilles: one chat each, where the developer explains an idea and a Claude Code planning
//     session (driven here over stream-json, see lib/planner.mjs) reads the project, asks its questions
//     and writes a plan;
//   - the plans (sessions, waves, stops, prompts), JSON files in plans/ written by the planning
//     session or dropped by hand, loaded into the database;
//   - the sessions of a plan, launched from the page: one `claude -p` process each (lib/planner.mjs,
//     the same pilot as the planning session) in its own git worktree (lib/worktree.mjs); their
//     state, stops and usage come from the stream, their permission requests go up to the page,
//     their messages land in session_messages, and the journal keeps every change of state.
//
// A launched session is 'running' during a turn, 'waiting' when its result arrives, 'done' when its
// ```escadrille:state block says done:true. The next waves start on their own: a 'later' session
// starts when every session it waits for (its `after`, or the whole previous wave) is done and
// merged; the merge follows done when the plan has autoMerge, else it waits for the button.
//
// Phase 4 (docs/sessions.md, "Le plafond, les alertes et la passation"): every session has a cap in
// dollars (the plan's `budget`, else DEFAULT_BUDGET_USD), passed as --max-budget-usd and held here too;
// at each turn an alert lands in pending when the cost passes ALERT_BUDGET of the cap or the context
// passes ALERT_CONTEXT of the window, once per threshold; past HANDOFF_CONTEXT the server asks the
// session for a handoff file, stops it, and starts a fresh one on the same branch with that file.
//
// API (JSON):
//   GET  /api/projects                     the projects of Escadrille (lib/projects.mjs registry), the most recently used first
//   POST /api/projects                     { path } (absolute or ~/…, an existing folder) → added to the list; 400 otherwise
//   POST /api/projects/remove              { path } → out of the list; nothing on disk or in the base is touched
//   GET  /api/projects/suggestions         the folders Claude Code worked in lately that are not in the list yet
//   GET  /api/projects/dirs?prefix=        the folders under a typed path, for the « Ajouter un projet » field
//   GET  /api/models                       { models: [{ id, name, provider, available, reason?, price?, default?, source }] }: lib/models.mjs, docs/models.md
//   GET  /api/escadrilles                  every escadrille: id, title, project, model, status, plan; stale: true when it waits
//                                          for an answer for more than 12 h (lib/waiting.mjs), folded on the home
//   GET  /api/escadrille/:id               the escadrille, its messages, its plan when there is one
//   GET  /api/templates                    the plan templates (plans/templates): id, title, summary, idea, fields
//   POST /api/escadrille                   { project, model, idea, template? } starts a planning session, answers { id }; an unknown template is a 400 (the template's hints join the planner's system prompt, GET /api/escadrille/:id gives 'template')
//   POST /api/escadrille/:id/message       { text } one more turn of the developer
//   POST /api/escadrille/:id/install       { items } the install list with its boxes ticked or not
//   POST /api/escadrille/:id/stop          ends the planning session (it can be resumed by a new message)
//   POST /api/plan                         a new version of a launched plan may add sessions and change the 'todo' or 'later' ones only:
//                                          else 409 { error, sessions: [one line per refused session] } (the planner's block is refused alike)
//   GET  /api/plans                        every plan: id, title, created, project
//   GET  /api/plan/:id                     { plan, state, log, estimate }: prompts as written, never the state instruction; each state entry has
//                                          open { folder, dev, url }, sessionId, mode ('page' | 'terminal' | null), worktree { path, branch, merged }, usage
//                                          { input, output, cost, weekly, context }, budget (USD), handoffs [{ n, at, file, text }], summary
//                                          and pending: [{ id, kind: 'permission', tool, input, text, network, suggest, at } | { id, kind: 'reply', stop, text, summary, at }
//                                          | { id, kind: 'alert', what: 'budget' | 'context', pct, text, at } | { id, kind: 'info', text, at }]
//                                          (network: an access outside localhost, which "always" never covers; pct: a fraction, 0.82 = 82 %)
//                                          (suggest: { allow, reason, rule } from lib/policy.mjs, or null when the rule has nothing to say: the page pre-selects, never answers)
//                                          and metrics { costPerMergedPr, attentionMinutes, sessionHours, unattended, cost, merged, … } (docs/mesure.md)
//   GET  /api/plan/:id/session/:sid/messages   { messages: [{ seq, role: claude | dev | activity | ask | system, text, data, at }] }
//   POST /api/plan/:id/session/:sid/message    { text } one more turn of the developer
//   POST /api/plan/:id/session/:sid/answer     { id, allow, always } the answer to a permission request
//   POST /api/plan/:id/session/:sid/dismiss    { id } removes an 'alert' or 'info' entry from pending
//   POST /api/plan/:id/session/:sid/merge      merges the session's branch into the project; { ok } or { error, conflict: true, files }
//   POST /api/plan/:id/session/:sid/terminal   stops the page process and opens `claude --resume` in a terminal
//   POST /api/plan/:id/session/:sid/resume     brings a terminal session back to the page
//   POST /api/plan/:id/session/:sid/stop       stops the process (a new message starts it again)
//   POST /api/plan/:id/retire              { why? } → { ok, stopped: [ids], closedAt }: stops every live session of the plan, empties its queue,
//                                          writes status 'closed' (base and plans/<id>.json); every start then refuses it (409). Idempotent
//   POST /api/plan/:id/reopen              → { ok }: the inverse, nothing restarts (docs/flot.md, « Retirer un plan »)
//   POST /api/plan/:id/settings            { autoMerge?, network?, autonomy? } (autonomy only hardens, else 400; docs/autonomy.md) (a missing field keeps its value; network: host names, validated,
//                                          the sandbox's allowedDomains at each start of a session)
//   POST /api/plan/:id/session/:sid/open       opens the session's folder (open on macOS), { ok }
//   GET  /api/plan/:id/session/:sid/diff       (Mac) { files, guarded, stat, patch, truncated }: git diff from the base, 200 KB at most
//   POST /api/plan/:id/session/:sid/reviewed   (Mac) { ok }: the human click that frees a session under guard (merge, next waves)
//   POST /api/plan/:id/session/:sid/run-tests (Mac) { ok, code }: the click that runs testCommand outside the sandbox, then merges if green
//   POST /api/plan/:id/session/:sid/continue-budget (Mac) { ok }: lifts askAboveUsd for the plan, the waves go on
//   POST /api/plan/:id/session/:sid/devserver  `npm run dev` in it, { ok, url } (url null when none is read in 20 s)
//   POST /api/plan/:id/session/:sid/pr     on the click only: push the branch of a done session, open its PR towards the base,
//                                          move its Linear tickets and comment them; { ok, pr: { url, number, base, head, at },
//                                          tickets: [{ identifier, state, ok, error }] }, kept in the pr column, a second click returns it
//   GET  /api/plan/:id/session/:sid/pr     the kept PR refreshed by gh pr view (state, merged, reviewDecision), on demand only
//                                          (docs/connectors.md; GET /api/plan/:id gives the kept pr in each state entry, never calling gh)
//   GET  /api/running                      { ours: [{ kind: 'session' | 'devserver' | 'worktree', plan, session, pid, cwd, url, since }],
//                                          others: [{ pid, cwd, since, args }] } (the other claude processes of the Mac, read only)
//                                          servers: [{ pid, command, port, url, cwd, project? }] (dev apps listening, lsof, 10 s cache),
//                                          vitals: { mem, cpu, server, claude } (lib/vitals.mjs); a devenv row has urls (environment.health)
//   POST /api/running/stop                 { kind, plan, session } → { ok }; POST /api/running/stop-all → { ok, stopped }
//   GET  /api/limits?project=              (Mac) { defaults, mac, project, effective, rows }: the thresholds per limit (docs/limits.md)
//   POST /api/limits                       (Mac) { scope: 'mac' | 'project', project?, limits: { <key>: { soft, hard, until? } | null } } → the same
//                                          (until: ISO end date; the previous value is kept and comes back alone at that hour)
//   POST /api/limits/resume                (Mac) { project } → { ok, resumed }: « Tout reprendre », the paused sessions resume now
//   GET  /api/status?project=              (Mac) the status panel beside the Conversation (docs/phase9/direction.md §4, lib/status.mjs):
//                                          now (running, waiting, queued, 4 rows), claude (weekly, 5 h, per model: the sessions' events and a
//                                          Haiku measure at most every 10 min while someone reads), cost (today, 7 days, last run), guard
//   GET  /api/usage                        past Claude Code sessions from their transcripts, and the weekly quota calibration (docs/estimation.md);
//                                          metrics { overall, plans: [{ id, title, costPerMergedPr, attentionMinutes, sessionHours, unattended }] } (?project=, docs/mesure.md);
//                                          ?only=metrics answers { metrics } alone, without reading the transcripts (the home)
//   POST /api/plan                         { id, title, goal, waves, sessions } creates or replaces a plan
//   POST /api/plan/:id/formula             { tier } takes the sessions of another formula (frugal, recommended, unlimited; lib/formulas.mjs)
//                                          before any session left, 409 after; GET /api/plan/:id answers its `formulas`, one line each
//   POST /api/note                         the developer's own line: { plan, session, note }
//   GET  /api/export/:id                   the plan, its state and its journal
//   POST /api/plan/:id/story               (Mac) writes the plan's story in <project>/docs/recits/<id>.md (replaced each time), { ok, file, text }
//   GET  /docs/<file>.md                   Escadrille's own docs/ (never another project's) rendered as a page; bounded to docs/, 404 otherwise
//   GET  /api/qa?project=                  { qa: [{ plan, title, session, at, status, ready, merged, url }] }: the QA plans of the runs, 3 most recent (docs/qa.md)
//   GET  /qa/:plan                         docs/qa/<plan>.md of the plan's QA session as a page (its worktree until merged), 404 while it is written
//   GET  /site/*                           the static site of site/ (index.html by default; html, css, js, svg, jpg, png, json)
//   POST /api/launch                       { plan } launches every 'todo' session of the plan, { ok, launched: [ids], queued: [ids] } (queued: refused by canStart, the project's queue); { plan, session } one of them
//   GET  /api/events?plan=:id | ?escadrille=:id   server-sent events: "change" on every write; for a plan also "message" { session, message }
//                                          on each message added and "pending" { session } when a session waits for the developer
//
// Phase 5, the phone (docs/phone.md): a request from the LAN gets 401 unless it carries a device token
// (Authorization: Bearer, or ?token= on /api/events), and with one it reaches only the phone's routes
// (403 elsewhere). The token comes from a 6-digit code shown on the Mac; the server pushes notifications
// through Expo's push service (ESCADRILLE_PUSH_URL), once per (plan, session, kind, mark), to the devices
// not seen in the last 15 s.
// Phase 12, the gate (docs/gate.md, lib/gate.mjs): « from the Mac » is not « the developer clicked », a session reaches
// 127.0.0.1 from its sandbox. Every route that acts (the ones marked (Mac) below, and every POST but /api/memory) asks for
// one of three proofs, checked once before the routes: the guard cookie escadrille_guard (GET /guard?k=…, the link in
// ~/.config/escadrille/guard-link, which the sessions cannot read), a paired device (the phone's Bearer within its routes,
// the poste's cookie escadrille_poste), or the pilot's token (header x-escadrille-pilot, ESCADRILLE_PILOT_TOKEN in the
// developer's shell, else ~/.config/escadrille/pilot-token; the sessions' environment drops it). Without one: 403
// { error, gate: { route, opens } }. POST /api/memory stays open to the sessions; …/reviewed takes the cookie alone.
// ESCADRILLE_GATE=off (the tests) opens the gate at start; run.sh never sets it.
//   POST /api/pair/code                    (Mac) { code, expires, address, lan }: a 10-minute, single-use code
//   POST /api/pair                         { code, name } → { token, device: { id, name, created } }, 401 { error } otherwise
//   GET  /api/phone                        (token) { device: { id, name }, plans, now }; the heartbeat of the open app
//   POST /api/phone/push-token             (token) { expoPushToken } → { ok }; POST /api/phone/forget → { ok }, the device is revoked
//   GET  /api/devices                      (Mac) { devices: [{ id, name, created, last_seen, push }], address, lan }
//   POST /api/devices/:id/forget           (Mac) { ok }
// The poste (docs/studio.md, lib/poste.mjs): POST /api/pair/code { kind: 'poste' } gives a code that pairs a Mac of the LAN;
// its token goes into an HttpOnly SameSite=Strict cookie (30 days) and opens every route except lib/poste.mjs studioOnly
// (terminal, open, devserver, pairing, devices, guard); its POSTs need Origin = http://<Host>.
//   GET  /pair                             the pairing page, served to the LAN without a token (a page without token: 401 with it)
//   GET  /api/whoami                       { mac, poste: { id, name } | null, host, address }
//
// Phase 6, the multiproject and the memory (docs/multiproject.md): a project is an absolute folder; plans carry
// it (plans.project, filled at start for the older ones), ?project= filters GET /api/plans, /api/escadrilles,
// /api/running (ours only) and /api/phone; /api/projects counts each one's escadrilles and plans.
//   GET  /api/docker?project= · GET /api/docker/logs?project=&service= (SSE) · POST /api/docker/action { project, service, action }
//                                          (Mac, guard cookie, docs/docker.md): the compose's services; restart, stop, build one of them
//   GET  /api/project/settings?project=    (Mac) { project, budget, network, model, addDirs, parallel, linear: { key: bool, state }, stored }: the stored settings, defaults for the rest
//   POST /api/project/domain               (Mac) { project, host, scope? | remove: true } → { ok, settings }: one line of the
//                                          project's list of domains (scope plan | sessions | both; none: its default)
//   POST /api/project/settings             (Mac) { project, budget?, network?, model?, addDirs?, parallel?, linearKey?, linearState?, autonomy?, environment? } → { ok, settings } (absent keeps, null clears;
//                                          environment (docs/devenv.md): the developer's guard cookie is required (403 without it: a session on 127.0.0.1 cannot write it);
//                                          its accounts go to ~/.config/escadrille/secrets.json, the GET returns their names and usernames only;
//                                          network: host names, IPv4, localhost, each with an optional :port; parallel: an integer ≥ 1, the project's queue:
//                                          at most N sessions running or waiting with a process; the Linear key goes to ~/.config/escadrille/secrets.json, never returned)
//   POST /api/plan/:id/session/:sid/budget (Mac) { budget } → { ok, budget, remaining, restarted }: the session's cap in the plan's JSON; a capped
//                                          session restarts with --resume and the rest (cap − spent, ≥ 0.50 $), else it applies at the next start
//   GET  /api/memory?project=              (Mac) { file, lines: [{ n, text }], total }: the last 2000 lines at most; { file: null, lines: [], total: 0 }
//   POST /api/memory                       (Mac) { project, line } → { ok, file }: one dated line at the end of the project's memory
//   GET  /api/tickets?project=&source=linear|github&q=   [{ id, title, state, url, source }], 50 at most, read only (docs/connectors.md)
//   POST /api/plan/from-tickets            { project, ids, idea?, model? } → { id }: a planning whose first message holds « ## Les tickets »
//   GET  /api/projectflow?project=[&all=1] (Mac) the project's flow: plans, nodes, edges, totals, story (docs/projectflow.md);
//                                          /api/events?project= sends "change" on every write to one of its plans
//   GET  /api/resources?project=           (Mac) what the project has: memory, rules, skills, plugins, addDirs, connectors, files (docs/resources.md)
//   GET  /api/resources/capabilities?project= (Mac) { rule, items }: ten capabilities worth adding at most, from local sources only
//   POST /api/resources/file               (Mac) { project, name, base64 | text, note? } → { ok, file }: into .escadrille/ressources/, 20 MB at most
//   POST /api/resources/note               (Mac) { project, path, note } → { ok }
//   DELETE /api/resources/file?project=&path= (Mac) a file the screen added, only
//   POST /api/resources/skill|plugin       (Mac) { project, name, enabled, confirm? } → { ok: false, preview } then { ok: true, file, line }
//   GET  /api/game?project=&plan=          XP, rank, achievements and the week, computed from the database ({ off: true } when game is false) (docs/game.md)
//   GET  /api/access?project=              (Mac) what the server and the sessions can read, write and reach, computed now (docs/access.md)
//
// Phase 7, the main conversation of a project (docs/mainchat.md, lib/mainchat.mjs): one thread per project that lasts
//   GET  /api/main?project=&before=&limit=&q=   (Mac) { project, messages: [{ seq, role, text, source, at, data }], more, total }, newest first
//   POST /api/main                         (Mac) { project, text } → { ok, message }: the developer's message (nothing answers yet)
//   GET  /api/main/pending?project=        (Mac) { project, since, messages }: the developer's messages after the last answer, the pilot's entry point
//   GET  /api/main/transcripts?project=    (Mac) { dir, files: [{ path, name, size, at, first, firstAt, entrypoint, imported }] }
//   POST /api/main/import                  (Mac) { project, path } → { ok, session, added, updated, kept, masked }; 400 outside ~/.claude/projects
// Phase 8 A, the pilot of a project (docs/pilot.md, lib/pilot.mjs)
//   GET  /api/pilot?project=               (Mac) { on, sessionId, busy, cursor, spentToday, budget, daily }
//   POST /api/pilot                        (Mac) { project, on } switches it; { project, pilotBudget, pilotDaily, pilotModel } sets its caps and model → { ok, pilot }
//   POST /api/main/accept                  (Mac) { project, seq } → { ok, plan, launched, queued }: « Lancer » on a proposed plan's card
//
// Phase 7, the burst « Jusqu'à la limite » (docs/burst.md, lib/burst.mjs, lib/horizon.mjs):
//   GET  /api/project/horizon?project=     (Mac) { usedPct, resetsAt, remainingPct, remainingUsd, hoursLeft, source: 'calibration' | 'none' }
//   GET  /api/project/backlog?project=     (Mac) { exists, file, tasks: [{ n, text, done }] }: docs/backlog.md of the project
//   POST /api/project/backlog              (Mac) { project, from: 'roadmap' | 'memory' | 'text', text? } → { exists, file, tasks }; 409 if it exists
//                                          or { project, from: 'defect', text, screen? } appends `- [ ] Défaut (<screen>) : <text>` (one line, text ≤ 300, screen ≤ 40; empty text → 400; file created if missing; never 409)
//   POST /api/burst                        (Mac) { project, tasks: [n…], capUsd, model?, drainMin? } → { id }: one task after the other, autonomous plans
//   POST /api/burst/:id/stop               (Mac) → { ok }: the hard stop, the processes of its plans stop
//   GET  /api/burst/:id                    (Mac) the burst: { id, project, status, capUsd, spentUsd, until, drainAt, tasks, log }
//   GET  /api/bursts?project=              (Mac) { bursts }, newest first
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, appendFileSync, statSync, rmSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { homedir, hostname, networkInterfaces } from 'node:os';
import path from 'node:path';
import { summarize as formulaLines, switchTo as formulaSwitch } from './lib/formulas.mjs';
import * as costing from './lib/costing.mjs'; // phase 11 PX: a task costed in three formulas before it is launched (docs/learning.md)
import { findBlocks, stripBlocks, validatePlan, validateInstall, validateQuestions, validateState, stopTitle, stopKind, stopFallback } from './lib/blocks.mjs';
import { startPlanner, startSession, safeEnv, sandboxSettings, validateDomains, sandboxStatus, READ_ONLY_TOOLS } from './lib/planner.mjs';
import { joinMessages } from './lib/coalesce.mjs';
import { withFrugal } from './lib/frugal.mjs';
import { pickTerminal } from './lib/terminal.mjs';
import * as running from './lib/running.mjs';
import * as vitalsLib from './lib/vitals.mjs';
import * as testapps from './lib/testapps.mjs'; // the test apps stop alone (Dev, 6 November)
import * as pilotdeath from './lib/pilotdeath.mjs'; // the pilot never dies in silence (Dev, 6 November 21:10)
import { estimatePlan, usageReport, calibrate, scanTranscripts } from './lib/usage.mjs';
import { memo, reviewStamp } from './lib/memo.mjs';
import * as worktree from './lib/worktree.mjs';
import * as testbox from './lib/testbox.mjs';
import * as push from './lib/push.mjs';
import * as poste from './lib/poste.mjs'; // the MacBook that pilots the Studio (docs/studio.md)
import { accessReport } from './lib/access.mjs';
import * as review from './lib/review.mjs';
import * as guardrails from './lib/guardrails.mjs'; // the protected guardrails (docs/autonomy.md, phase 10 E)
import * as mergeprivacy from './lib/mergeprivacy.mjs'; // the private-life net at merge time (lib/privacy.mjs on added lines)
import * as gate from './lib/gate.mjs'; // the gate before the routes: what a session on 127.0.0.1 may not do (docs/gate.md, phase 12 SEC)
import * as branchfiles from './lib/branchfiles.mjs'; // what a branch brings itself, a merge of its base left out
import * as selfedit from './lib/selfedit.mjs'; // the install firewall: a plain install never plans nor launches a session on Escadrille itself
// Throws 403 when root is Escadrille and this install may not modify it (lib/selfedit.mjs)
const guardSelfEdit = (root) => { if (root && guardrails.isEscadrille(root) && !selfedit.selfEdit(root).allowed) { const e = new Error(selfedit.REFUSAL); e.status = 403; throw e; } };
import { flowOf, humanOf } from './lib/projectflow.mjs';
import * as domains from './lib/domains.mjs'; // one list of domains per project, a scope per line (docs/access.md, « Domaines »)
import { isRetired, retiredError, retiredPlan, reopenedPlan } from './lib/retire.mjs'; // retire a plan (docs/flot.md, « Retirer un plan »)
import { openFixesIn, fixesRefusal } from './lib/leftfixes.mjs'; // a fix left to apply by hand holds the session's end (Dev, 2026-11-03)
import { remaining, createQueue, isFinished, planChangeRefusals, holdsSlot } from './lib/queue.mjs';
import * as autonomy from './lib/autonomy.mjs';
import * as resources from './lib/resources.mjs';
import * as mainchat from './lib/mainchat.mjs';
import * as pilotlog from './lib/pilotlog.mjs'; // Phase 8 D
import * as pilot from './lib/pilot.mjs'; // Phase 8 A
import { guardFilesArgs, filesOf as guardFiles } from './lib/guardbase.mjs';
import { nextStep, cranOf } from './lib/nextstep.mjs'; // FIAB: the pilot reads who acts, never computes it again (Dev, 6 Nov. 22:35)
import * as todo from './lib/todo.mjs'; // Phase 11 X: who has to act, the presence of an external pilot
import * as projectlogo from './lib/projectlogo.mjs'; // Phase 11 X: the logo of a project, read in its folder
import { render as renderMarkdown, docPage, firstTitle, SHELL_SERVER } from './lib/markdown.mjs';
import { planMetrics, overallMetrics } from './lib/metrics.mjs';
import { storyOf, projectOfStory, pilotCostIn } from './lib/story.mjs';
import * as pilotwatch from './lib/pilotwatch.mjs'; // PIL 3 November: the pilot's watchdog, never a mute request
import * as readonly from './lib/readonly.mjs'; // PIL 23:55: the read-only Bash commands the engine allows alone
import { listModels, isModel, modelName, plannerModel, pilotModel } from './lib/models.mjs';
import { suggest as suggestPermission } from './lib/policy.mjs';
import * as github from './lib/github.mjs';
import * as ghroutes from './lib/ghroutes.mjs'; // Phase 16 GH: the PR routes, the merge on the page cookie (docs/connectors.md)
import * as ghrelay from './lib/ghrelay.mjs'; // Phase 16 GH: what GitHub asks to fix goes back to the session, once per cause
import * as linear from './lib/linear.mjs';
import * as linearsync from './lib/linearsync.mjs'; // the Linear sync (docs/connectors.md « La synchro »): the tickets a session names, updated alone
import * as secrets from './lib/secrets.mjs';
import * as tickets from './lib/tickets.mjs'; // phase 16 TIX: a planning from the project's tickets, read only (docs/connectors.md)
import { mapOf, architectureDelta } from './lib/architecture.mjs';
import * as burst from './lib/burst.mjs';
import * as backlogmod from './lib/backlog.mjs'; // the backlog page and « Ajouter à un plan » (docs/backlog-page.md)
import { isStalePlanning } from './lib/waiting.mjs';
import { horizonOf, weeklyNow } from './lib/horizon.mjs';
import * as limits from './lib/limits.mjs';
import * as status from './lib/status.mjs'; // Phase 9 P1, the status panel
import * as registry from './lib/projects.mjs'; // Phase 11 S, the projects given to Escadrille
import * as game from './lib/game.mjs'; // the progression, docs/game.md
import { captureTarget, parseCaptures, folderName, captureNote, createCaptureQueue } from './lib/capture.mjs'; // Phase 8 B, docs/capture.md
import * as docker from './lib/docker.mjs'; // Phase 16 DOCK, docs/docker.md: the compose's services, the developer's clicks, DOCKER: lines
import * as projecttests from './lib/projecttests.mjs'; // docs/projecttests.md: a session's TEST: <name> lines, the project's declared tests outside the sandbox
import * as gitops from './lib/gitops.mjs'; // docs/gitops.md: a session's GIT: lines (commit, branch, switch, merge) in its worktree, outside the sandbox, never push
import * as devenv from './lib/devenv.mjs'; // Phase 13 ENV, docs/devenv.md: the dev environment a project declares, ENV: lines, the tests of a repository
import { parseQaLines, parseConnectedCaptures, qaFolderName, createQaQueue } from './lib/qarun.mjs'; // Phase 13 QR, docs/qarun.md: QA: lines played outside the sandbox
import * as qaloop from './lib/qaloop.mjs'; // Phase 13 PIL: the failures go back once to the session, the true defects to « À toi »
import * as checks from './lib/checks.mjs'; // Phase 13 PIL: the checks a project declares, run at a stop
import * as pilotpolicy from './lib/pilotpolicy.mjs'; // Phase 13 PIL: the permission policy of a project
import * as wake from './lib/wake.mjs'; // Phase 13 PIL: the filter and the Haiku triage of the pilot's wakes
import * as asks from './lib/asks.mjs'; // « À toi »: the permissions that wait for the developer, explained (docs/asks.md)
import { mergedInto, targetOf, mergedWaitingOver, staleError, HEALTH_CLEARED } from './lib/mergedin.mjs'; // a branch merged outside the server, and the branch a session is merged into
import * as pilothandoff from './lib/pilothandoff.mjs'; // Phase 13 PIL: the pilot's handoff
import * as msgtriage from './lib/msgtriage.mjs'; // Phase 13 PIL: the triage of the developer's messages, the delegated questions
import * as license from './lib/license.mjs'; // the Escadrille Équipe key, offline (docs/vente/licence.md): without one the team sharing stays off, the solo is untouched
import * as team from './lib/team.mjs';// PoC « Escadrille en équipe » (docs/team.md): presence and team memory through a relay, metadata only, off by default
import { validateReleases, buildRelease, releaseNote } from './lib/release.mjs'; // Phase 10 J, docs/sessions.md « Les fusions de release »
import { claudeStatus } from './lib/claudecheck.mjs';
import * as i18n from './lib/i18n.mjs'; // phase 9 I: the two languages, public/i18n/i18n.js
import * as qa from './lib/qa.mjs'; // phase 10 H: the QA plan of a run, docs/qa.md
import * as donethread from './lib/donethread.mjs'; // phase 16 PAIR: the end report and the review thread, docs/review.md
import * as learning from './lib/learning.mjs'; // phase 11 LR: what Escadrille learns from its use, docs/learning.md
import * as replies from './lib/replies.mjs'; // FILE: the replies to the launch posts, docs/replies.md
import { createDemo } from './lib/demo.mjs'; // the live software demo, docs/demo.md: public/ of a throwaway branch served over ours
import * as comm from './lib/comm.mjs'; // the Communication screen: comm/ of the project, read at every opening
import * as names from './lib/names.mjs'; // the technical names (calmdev, else escadrille) and their migration, docs/decisions.md 5 Nov 22:30
const { vars, projectDir, projectRel } = names;
const { msg } = i18n;
// CALMDEV_X reaches the readers that only know ESCADRILLE_X (lib/guardrails.mjs), and the config folder moves to
// ~/.config/calmdev once, a link left at the old path, before anything reads it. A server under node --test leaves the
// developer's home alone unless CALMDEV_MIGRATE=on; CALMDEV_MIGRATE=off stops every migration.
names.bridgeEnv();
const MIGRATE = vars.MIGRATE !== 'off' && (!process.env.NODE_TEST_CONTEXT || vars.MIGRATE === 'on');
if (MIGRATE) for (const r of names.migrateAll({ log: (l) => console.log('names: ' + l) })) if (r.state === 'error') console.error('names: ' + r.what + ' not migrated (' + r.error + ')');

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 3078);
// Where the server listens: this Mac only by default; ESCADRILLE_HOST=0.0.0.0 (./run.sh --lan) opens it to the LAN, for the phone
const HOST = vars.HOST || '127.0.0.1';
const DB_FILE = vars.DB || process.env.SM_DB || path.join(HERE, 'sessions.sqlite');
const PLANS_DIR = vars.PLANS || path.join(HERE, 'plans'); // the tests point it at a throwaway folder
// The terminal "Ouvrir dans un terminal" opens (lib/terminal.mjs): macOS Ghostty or Terminal.app; Linux SM_TERMINAL,
// tmux, kitty, gnome-terminal, konsole, xterm. Chosen once at start; TERMINAL is its name, or 'aucun'
const PICKED_TERMINAL = pickTerminal();
const TERMINAL = PICKED_TERMINAL.name || 'aucun';
// The cap and the thresholds of a launched session (docs/sessions.md), each overridden by an environment variable
const num = (v, dflt) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : dflt);
const DEFAULT_BUDGET_USD = num(vars.BUDGET_USD, 5); // the cap in US dollars when the plan says nothing
const ALERT_BUDGET = num(vars.ALERT_BUDGET, 0.8); // share of the cap that raises the budget alert
const ALERT_CONTEXT = num(vars.ALERT_CONTEXT, 0.6); // share of the context window that raises the context alert
// A fresh session whose first turn already passes the threshold would hand off again and again: after this many, it just waits
const MAX_HANDOFFS = 5;
const HANDOFF_CONTEXT = num(vars.HANDOFF_CONTEXT, 0.75); // share of the context window that triggers the handoff
const NPM = vars.NPM || 'npm'; // the npm that runs a project's dev server (the tests give a fake one)
const DEV_TIMEOUT_MS = num(vars.DEV_TIMEOUT_MS, 20000); // how long the server reads a dev server's output for its URL
// The phone (docs/phone.md): where the notifications go, how long a device token and a pairing code last
const PUSH_URL = vars.PUSH_URL || push.PUSH_URL; // the tests point it at a local fake
const TOKEN_DAYS = 90; const CODE_TTL_MS = 10 * 60000; const CODE_TRIES = 5;
// Set by the tests only: with it, a request carrying `x-escadrille-remote: 1` counts as coming from the LAN
const TEST_REMOTE = vars.TEST_REMOTE === '1';
// A busy timeout: a test or a tool reading the same file holds a shared lock for a moment; without it a write under load
// throws « database is locked » and the route fails (2026-11-02, the suite merged dry into main)
const db = new DatabaseSync(DB_FILE, { timeout: 5000 });
db.exec(`
  create table if not exists plans (id text primary key, title text, created text, json text);
  create table if not exists sessions (plan text, id text, status text, stops text, health text, why text, claude text, note text, name text, at text, primary key (plan, id));
  create table if not exists log (seq integer primary key autoincrement, plan text, session text, at text, status text, stops text, health text, why text, claude text, name text);
  create table if not exists escadrilles (id text primary key, title text, project text, model text, session_id text, plan_id text, status text, install text, usage text, weekly real, reset_at text, created text, at text);
  create table if not exists messages (seq integer primary key autoincrement, escadrille text, role text, text text, data text, at text);
  create index if not exists messages_escadrille on messages (escadrille, seq);
  create table if not exists session_messages (seq integer primary key autoincrement, plan text, session text, role text, text text, data text, at text);
  create index if not exists session_messages_key on session_messages (plan, session, seq);
  create index if not exists log_plan on log (plan, session, seq);
  create index if not exists session_messages_role on session_messages (plan, role, session, seq);
  create table if not exists devices (id text primary key, name text, token_hash text unique, expo_push_token text, created text, last_seen text, revoked text);
  create table if not exists project_settings (project text primary key, json text, at text);
`);
burst.ensureTable(db); // phase 7: the bursts « Jusqu'à la limite » (docs/burst.md)
mainchat.schema(db); // phase 7: the main conversation of a project (docs/mainchat.md)
// Phase 8 D, the pilot's log (docs/pilotlog.md): table pilot_actions
pilotlog.schema(db);
donethread.schema(db); // Phase 16 PAIR: review_done, review_thread
// The Linear sync (docs/connectors.md « La synchro »): table linear_sync; the key read from the secrets file at each call, never kept here
linearsync.init({ db, keyOf: (p) => secrets.get(p, 'linear'), settingsOf: (p) => storedSettings(p), log: (r) => pilotRecord(r) });
ghrelay.schema(db);
// Phase 6 (docs/multiproject.md): the project of a plan, filled at start for the plans written before it
if (!db.prepare('pragma table_info(plans)').all().some((c) => c.name === 'project')) db.exec('alter table plans add column project text');
if (!db.prepare('pragma table_info(devices)').all().some((c) => c.name === 'kind')) db.exec("alter table devices add column kind text default 'phone'"); // 'phone' | 'poste' (docs/studio.md)
// Phase 7: the plan template an escadrille started from (plans/templates)
if (!db.prepare('pragma table_info(escadrilles)').all().some((c) => c.name === 'template')) db.exec('alter table escadrilles add column template text');
// The columns phase 3 added to the sessions: the Claude Code session id, how it runs, its worktree, usage and what it waits for;
// phase 4: its handoffs, the summary of its last state block, the alert thresholds already raised; phase 5: the notifications already pushed
for (const [col, type] of [['session_id', 'text'], ['mode', 'text'], ['worktree', 'text'], ['usage', 'text'], ['pending', 'text'], ['handoffs', 'text'], ['summary', 'text'], ['alerted', 'text'], ['pushed', 'text'], ['queued', 'integer'], ['pr', 'text'], ['review', 'text'], ['pause', 'text'], ['inbox', 'text']]) if (!db.prepare('pragma table_info(sessions)').all().some((c) => c.name === col)) db.exec(`alter table sessions add column ${col} ${type}`);

const STATUSES = new Set(['later', 'todo', 'running', 'waiting', 'paused', 'done']); // paused: at a hard threshold, resumes alone (lib/limits.mjs)
const HEALTH = new Set(['ok', 'drift', 'error']);
const now = () => new Date().toISOString();
const slug = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------------------------------------------------------------- plans and the sessions' state
const loadPlans = () => {
  if (!existsSync(PLANS_DIR)) mkdirSync(PLANS_DIR);
  for (const f of readdirSync(PLANS_DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const plan = JSON.parse(readFileSync(path.join(PLANS_DIR, f), 'utf8'));
      const cur = db.prepare('select json from plans where id = ?').get(plan.id);
      if (!cur || cur.json !== JSON.stringify(plan)) upsertPlan(plan);
    } catch (e) { console.error(`plans/${f}: ${e.message}`); }
  }
};
// A launched plan never loses nor changes a launched session (docs/sessions.md, « La robustesse »): the refusals of a new version
const planRefusals = (next) => planChangeRefusals(planOf(next.id), db.prepare('select id, status from sessions where plan = ?').all(next.id), next);
const upsertPlan = (plan) => {
  db.prepare('insert into plans (id, title, created, json, project) values (?, ?, ?, ?, ?) on conflict(id) do update set title = excluded.title, json = excluded.json, project = coalesce(excluded.project, plans.project)')
    .run(plan.id, plan.title, plan.created || now(), JSON.stringify(plan), plan.project || null);
  for (const s of plan.sessions) {
    const exists = db.prepare('select 1 from sessions where plan = ? and id = ?').get(plan.id, s.id);
    if (!exists) db.prepare('insert into sessions (plan, id, status, stops, health, why, claude, note, name, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(plan.id, s.id, s.wave > 1 ? 'later' : 'todo', '[]', 'ok', '', '', '', s.name, now());
  }
};
const planOf = (id) => { const r = db.prepare('select json, project from plans where id = ?').get(id); if (!r) return null; const p = JSON.parse(r.json); return { ...p, project: p.project ?? r.project ?? null }; };
// ---------------------------------------------------------------- projects (phase 6, docs/multiproject.md)
// The git root of a folder, read from the files (no git): the first parent holding .git; a worktree's .git file
// (gitdir: <repo>/.git/worktrees/<name>) gives <repo>; without .git, the folder itself
export const gitRootOf = (p) => {
  if (!p) return null;
  for (let d = path.resolve(p); ; d = path.dirname(d)) {
    const g = path.join(d, '.git');
    try {
      const st = statSync(g);
      if (st.isDirectory()) return d;
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'));
      const wt = m && /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(m[1].trim());
      return wt ? wt[1] : d;
    } catch {}
    if (path.dirname(d) === d) return path.resolve(p);
  }
};
const projectName = (p) => (p ? path.basename(p) : null);
// ?project= or { project }: an absolute folder that exists, without its trailing slash; throws otherwise
const projectArg = (v) => {
  const p = String(v || '').trim();
  if (!p || !path.isAbsolute(p)) throw new Error('project : un chemin absolu');
  const r = path.resolve(p);
  if (!existsSync(r) || !statSync(r).isDirectory()) throw new Error('project : dossier introuvable');
  return r;
};
// The optional filter of a GET: null without ?project=
const projectFilter = (url) => { const v = String(url.searchParams.get('project') || '').trim(); return v ? path.resolve(v) : null; };
const projectOfPlan = (id) => db.prepare('select project from plans where id = ?').get(id)?.project ?? null;
// The plans written before phase 6: their escadrille's project, else the git root of their first session's path
const migrateProjects = () => {
  for (const r of db.prepare('select id, json from plans where project is null').all()) {
    const plan = parse(r.json, {});
    const e = db.prepare('select project from escadrilles where plan_id = ? and project is not null limit 1').get(r.id);
    const first = Array.isArray(plan.sessions) ? plan.sessions.find((s) => s && s.path)?.path : null;
    const project = e?.project || plan.project || (first ? gitRootOf(first) : null);
    if (project) db.prepare('update plans set project = ? where id = ?').run(project, r.id);
  }
};

// The settings of a project: what Dev wrote (stored), the defaults for the rest
const SETTING_KEYS = ['budget', 'network', 'model', 'addDirs', 'parallel', 'linearState', 'linearSync', 'review', 'retryMax', 'autonomy', 'game', 'autoBurst', 'limits', 'qa', 'environment'];
const storedSettings = (project) => parse(db.prepare('select json from project_settings where project = ?').get(project)?.json, {});
// The dev environment of a project (docs/devenv.md) and its test accounts, the latter in the secrets file, never in the base
const environmentOf = (project) => (project && storedSettings(project).environment) || null;
const envAccountsOf = (project) => devenv.parseAccounts(secrets.get(project, 'devenv'));
const settingsOf = (project) => {
  const st = storedSettings(project);
  const lastModel = db.prepare('select model from escadrilles where project = ? and model is not null order by at desc limit 1').get(project)?.model ?? null;
  return { project, game: st.game !== false, qa: st.qa !== false, budget: st.budget ?? DEFAULT_BUDGET_USD, network: projectNetwork(project), model: st.model ?? lastModel, addDirs: st.addDirs ?? [], review: st.review ?? review.DEFAULT_LEVEL, retryMax: st.retryMax ?? review.DEFAULT_RETRY_MAX, parallel: st.parallel ?? null, autoBurst: st.autoBurst ?? null, linear: { key: secrets.has(project, 'linear'), state: st.linearState ?? linear.DEFAULT_STATE, ...linearsync.publicView(st, secrets.has(project, 'linear')) }, environment: devenv.publicView(st.environment || null, envAccountsOf(project)), stored: SETTING_KEYS.filter((k) => st[k] !== undefined),
    // « Qui décide quand je ne suis pas là ? » (docs/first-run.md): the mode with the cran it makes with the pilot switch
    // (docs/nextstep.md, « Le cran »), what it costs at most (the pilot's caps) and whether the first run still asks
    autonomy: (() => { const a = projectAutonomyOf(project); const pilotOn = st.pilot?.on === true;
      return { ...a, pilotOn, cran: cranOf({ pilotOn, mode: a.mode }), caps: { wake: st.pilotBudget ?? pilot.DEFAULT_BUDGET, day: st.pilotDaily ?? pilot.DEFAULT_DAILY, plan: st.pilotPlanCapUsd ?? pilot.DEFAULT_PLAN_CAP }, ask: st.whoAsk === true }; })() };
};
// A project added from the app starts with « Je valide le goût et la sécurité » (mode guide) and no automatic burst:
// the first run of a new developer (backlog, Dev 6 November); a project with a stored autonomy keeps it
const firstSettings = (project) => { const st = storedSettings(project); if (st.autonomy) return;
  st.autonomy = autonomy.validateAutonomy({ mode: 'guide' }).value; st.whoAsk = true;
  db.prepare('insert into project_settings (project, json, at) values (?, ?, ?) on conflict(project) do update set json = excluded.json, at = excluded.at').run(project, JSON.stringify(st), now()); };
// The network of a project's settings, as a plan takes it: host names (validateDomains), plus an IPv4 address,
// localhost, or any of them with a port (127.0.0.1:3318, a local test database)
const validateNetwork = (list) => {
  if (!Array.isArray(list)) return validateDomains(list);
  const domains = []; const errors = [];
  for (const d of list) {
    const h = typeof d === 'string' ? d.trim().toLowerCase().replace(/\.$/, '') : '';
    const m = /^(.+?)(?::(\d{1,5}))?$/.exec(h); const host = m ? m[1] : ''; const port = m && m[2] ? Number(m[2]) : null;
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split('.').every((n) => Number(n) <= 255);
    const ok = host && (port === null || (port >= 1 && port <= 65535)) && (ip || host === 'localhost' || !validateDomains([host]).errors);
    if (!ok) { errors.push(...(validateDomains([d]).errors || [`${h} : pas un hôte ni une adresse`])); continue; }
    if (!domains.includes(h)) domains.push(h);
  }
  return { domains, errors: errors.length ? errors : null };
};
// The project's one list of domains, [{ host, scope }] (lib/domains.mjs): what the sandboxes open, by role
const projectNetwork = (project) => (project ? domains.entriesOf(storedSettings(project).network, validateNetwork) : []);
const networkFor = (plan, role) => (plan?.closedNetwork ? [] : domains.hostsFor(projectNetwork(plan?.project || null), role));
// At start, once per project: its list = its setting ∪ the domains of its plans not retired, each with its default scope
// The planning run (not the pilot, not a small call): its sandbox opens the hosts scoped `plan` or `both`, and WebFetch
// reaches the exact ones (dontAsk: nothing else is allowed). Without such a host, the planner has no network at all.
const plannerNetwork = (project) => {
  const hosts = domains.hostsFor(projectNetwork(project), 'plan'); if (!hosts.length) return {};
  return { settings: withFrugal(sandboxSettings(hosts)), allowedTools: [...READ_ONLY_TOOLS, ...hosts.filter((h) => !h.startsWith('*.') && !/:\d+$/.test(h)).map((h) => `WebFetch(domain:${h})`)] };
};
const migrateNetworks = () => {
  const rows = db.prepare('select id, project from plans where project is not null').all();
  const projects = new Set([...rows.map((r) => r.project), ...db.prepare('select project from project_settings').all().map((r) => r.project)]);
  for (const project of projects) {
    const lists = rows.filter((r) => r.project === project).map((r) => planOf(r.id)).filter((p) => p && !isRetired(p)).map((p) => p.network || []);
    const { st, migrated } = domains.migrateSettings(storedSettings(project), lists, validateNetwork);
    if (!migrated) continue;
    db.prepare('insert into project_settings (project, json, at) values (?, ?, ?) on conflict(project) do update set json = excluded.json, at = excluded.at').run(project, JSON.stringify(st), now());
    console.log(`domaines : ${project} migré, ${st.network.length} domaine(s) au projet (${st.network.map((e) => `${e.host} ${e.scope}`).join(', ') || 'aucun'})`);
  }
};
const writeSettings = (b, { guardKey = null } = {}) => {
  const project = projectArg(b.project); const st = storedSettings(project);
  // The dev environment (docs/devenv.md): the developer's click only (the guard cookie, docs/autonomy.md); a session reaching
  // 127.0.0.1 gets 403. The accounts go to the secrets file; null clears both.
  if (b.environment !== undefined) {
    if (!guardrails.keyMatches(guardKey, GUARD_KEY)) { const e = new Error(msg('srv.s.guardKey', { file: path.join(guardrails.dirOf(), 'guard-link') })); e.status = 403; throw e; }
    if (b.environment === null) { delete st.environment; secrets.clear(project, 'devenv'); }
    else {
      const { value, accounts, errors } = devenv.validateEnvironment(b.environment, { project }); if (errors) throw new Error(errors.join(' ; '));
      const dk = docker.validateDocker(b.environment.docker); if (dk.errors) throw new Error(dk.errors.join(' ; ')); if (dk.value) value.docker = dk.value; // docs/docker.md
      const pt = projecttests.validateTests(b.environment.projectTests); if (pt.errors) throw new Error(pt.errors.join(' ; ')); if (pt.value) value.projectTests = pt.value; // docs/projecttests.md
      st.environment = value;
      if (accounts === null) { /* absent: the stored accounts stay */ } else if (Object.keys(accounts).length) secrets.set(project, 'devenv', JSON.stringify(accounts)); else secrets.clear(project, 'devenv');
    }
  }
  if (b.game !== undefined) { if (b.game === null || b.game === true) delete st.game; else if (b.game === false) st.game = false; else throw new Error('game : true ou false'); }
  if (b.qa !== undefined) { if (b.qa === null || b.qa === true) delete st.qa; else if (b.qa === false || b.qa === 'plan') st.qa = b.qa; else throw new Error('qa : true, false ou « plan »'); } // FIAB 6: 'plan', the old QA per plan, by hand
  if (b.budget !== undefined) { if (b.budget === null) delete st.budget; else { const n = Number(b.budget); if (!Number.isFinite(n) || n <= 0 || typeof b.budget === 'boolean') throw new Error('budget : un nombre de dollars > 0'); st.budget = n; } }
  // network: the project's one list of domains, [{ host, scope }]; a bare host name takes its default scope (lib/domains.mjs)
  if (b.network !== undefined) { if (b.network === null) delete st.network; else { const { entries, errors } = domains.toEntries(b.network, validateNetwork); if (errors) throw new Error(errors.join(' ; ')); st.network = entries; } st.networkScoped = true; }
  if (b.model !== undefined) { if (b.model === null) delete st.model; else { if (!isModel(b.model)) throw new Error(`model : modèle inconnu ${b.model}`); st.model = b.model; } }
  if (b.parallel !== undefined) { if (b.parallel === null) delete st.parallel; else { const n = Number(b.parallel); if (!Number.isInteger(n) || n < 1 || typeof b.parallel === 'boolean') throw new Error('parallel : un entier ≥ 1'); st.parallel = n; } }
  if (b.retryMax !== undefined) { if (b.retryMax === null) delete st.retryMax; else { if (!Number.isInteger(b.retryMax) || b.retryMax < 0 || b.retryMax > 10) throw new Error('retryMax : un entier de 0 à 10'); st.retryMax = b.retryMax; } }
  if (b.review !== undefined) { if (b.review === null) delete st.review; else { if (!review.LEVELS.includes(b.review)) throw new Error(`review : ${review.LEVELS.join(', ')}`); st.review = b.review; } }
  if (b.autoBurst !== undefined) { const v = burst.validateAutoBurst(b.autoBurst); if (v === null) delete st.autoBurst; else st.autoBurst = v; }
  if (b.limits !== undefined) { if (b.limits === null) delete st.limits; else { const { value, errors } = limits.validateThresholds(b.limits); if (errors) throw new Error(errors.join(' ; ')); st.limits = value; } }
  if (b.addDirs !== undefined) {
    if (b.addDirs === null) delete st.addDirs;
    else {
      if (!Array.isArray(b.addDirs)) throw new Error('addDirs : une liste de chemins absolus');
      st.addDirs = [...new Set(b.addDirs.map((d) => { const p = String(d || '').trim(); if (!path.isAbsolute(p) || !existsSync(p) || !statSync(p).isDirectory()) throw new Error(`addDirs : ${p || '(vide)'} n’est pas un dossier absolu existant`); return path.resolve(p); }))];
    }
  }
  // The autonomy (docs/autonomy.md): the fields given replace the stored ones, the whole validated field by field
  if (b.autonomy !== undefined) delete st.whoAsk; // the first-run question is answered once the mode is saved
  if (b.autonomy !== undefined) { if (b.autonomy === null) delete st.autonomy; else { if (!b.autonomy || typeof b.autonomy !== 'object' || Array.isArray(b.autonomy)) throw new Error('autonomy : un objet { mode, … }'); const { value, errors } = autonomy.validateAutonomy({ ...(st.autonomy || {}), ...b.autonomy }); if (errors) throw new Error(errors.join(' ; ')); st.autonomy = value; } }
  // The Linear key goes to ~/.config/escadrille/secrets.json, never into the database (docs/connectors.md)
  if (b.linearKey !== undefined) { if (b.linearKey === null) secrets.clear(project, 'linear'); else if (typeof b.linearKey !== 'string' || !b.linearKey.trim()) throw new Error('linearKey : une clé non vide, ou null pour l’effacer'); else secrets.set(project, 'linear', b.linearKey); }
  if (b.linearState !== undefined) { if (b.linearState === null) delete st.linearState; else { const n = String(b.linearState).trim(); if (!n || n.length > 60) throw new Error('linearState : le nom d’un statut Linear'); st.linearState = n; } }
  if (b.linearSync !== undefined) linearsync.applySetting(st, b.linearSync); // false turns the sync off; true or null: on with a key (docs/connectors.md)
  db.prepare('insert into project_settings (project, json, at) values (?, ?, ?) on conflict(project) do update set json = excluded.json, at = excluded.at').run(project, JSON.stringify(st), now());
  if (b.autonomy !== undefined) setImmediate(() => armFallbacks());
  return { ok: true, settings: settingsOf(project) };
};
// A plan about to be validated: what it lacks comes from the project's stored settings, written into it (a plan is a contract)
const withSettings = (raw, project) => {
  if (!project || !raw || typeof raw !== 'object') return raw;
  const st = storedSettings(project); const p = { ...raw };
  if (p.addDirs === undefined && st.addDirs) p.addDirs = st.addDirs;
  if (p.autonomy === undefined && st.autonomy) p.autonomy = st.autonomy;
  if (st.budget !== undefined && Array.isArray(p.sessions)) p.sessions = p.sessions.map((s) => (s && typeof s === 'object' && s.budget === undefined ? { ...s, budget: st.budget } : s));
  return p;
};
// The project of a plan given by POST /api/plan: the one it says, else the git root of its first session's path
const projectOfRaw = (raw) => {
  if (typeof raw?.project === 'string' && raw.project.trim()) return path.resolve(raw.project.trim());
  const first = Array.isArray(raw?.sessions) ? raw.sessions.find((s) => s && s.path)?.path : null;
  return first ? gitRootOf(String(first)) : null;
};

// ---------------------------------------------------------------- the memory of a project (docs/multiproject.md)
// <project>/docs/decisions.md when it exists, else <project>/.escadrille/memoire.md; the file is the truth
const MEMORY_MAX_LINES = 2000; const MEMORY_PROMPT_LINES = 40;
const memoryFileOf = (project) => { const d = path.join(project, 'docs', 'decisions.md'); return existsSync(d) ? d : projectDir(project, 'memoire.md'); };
const memoryLines = (file) => { const t = readFileSync(file, 'utf8'); const l = t.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
const memoryOf = (project) => {
  const file = memoryFileOf(project); if (!existsSync(file)) return { file: null, lines: [], total: 0 };
  const all = memoryLines(file); const from = Math.max(0, all.length - MEMORY_MAX_LINES);
  return { file, lines: all.slice(from).map((text, i) => ({ n: from + i + 1, text })), total: all.length };
};
const pad = (n) => String(n).padStart(2, '0');
const addMemory = (b) => {
  const project = projectArg(b.project); const line = typeof b.line === 'string' ? b.line.trim() : '';
  if (!line) throw new Error('line : une ligne vide');
  if (/[\r\n]/.test(line)) throw new Error('line : une seule ligne, sans retour chariot');
  if (line.length > 2000) throw new Error('line : 2000 caractères au plus');
  const file = memoryFileOf(project); mkdirSync(path.dirname(file), { recursive: true });
  const d = new Date(); const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} (${pad(d.getHours())}:${pad(d.getMinutes())})`;
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}- **${stamp}** : ${line}\n`);
  const shared = team.teamLine(line); if (shared) teamSync.sendMemory(project, shared).then((r) => { if (!r.sent && r.error !== 'partage éteint' && r.error !== 'lecture seule') console.error('team memory:', r.error); }); // « équipe : … » also goes to the relay (docs/team.md)
  return { ok: true, file };
};
// What the planning session gets: the last 40 non-empty lines of the memory, nothing when there is no file; then the team's
// section when the sharing is on (docs/team.md)
export const memorySection = (project) => {
  if (!project) return '';
  const file = memoryFileOf(project); const lines = existsSync(file) ? memoryLines(file).filter((l) => l.trim()).slice(-MEMORY_PROMPT_LINES) : [];
  return (lines.length ? `\n\n## La mémoire du projet\n\nFichier : ${file}\n${lines.join('\n')}` : '') + teamSectionOf(project);
};

// ---------------------------------------------------------------- Escadrille en équipe, the PoC (docs/team.md, lib/team.mjs)
// The setting team: { relay, member, on } in project_settings, the token in ~/.config/escadrille/secrets.json ('team'), never in the
// base, never returned, never logged. When on: every TEAM_INTERVAL_MS and at each change of state of a session of the project, PUT
// our presence (sessions running, waiting or paused: title, branch, status, files changed since the base, areas of `where`), GET the
// others', GET the team memory. A collision (lib/team.mjs collisions) raises one 'info' entry in the pending of our session, once per
// pair, and a system line with the detail; the lines of the others land in <project>/.escadrille/equipe.md.
const TEAM_INTERVAL_MS = Number(vars.TEAM_INTERVAL_MS) || team.INTERVAL_MS;
const TEAM_PLANNED_DAYS = 14; // a planned session (todo, later) of a plan this recent counts as ours
const teamStored = (project) => storedSettings(project).team || null;
// The licence (lib/license.mjs, docs/vente/licence.md): none or invalid, the sharing stays off whatever the setting says; expired or
// revoked, read only (others read, nothing published); the setting and the files are kept either way
const licenseNow = () => license.current();
const teamPublicOf = (project) => { const lic = licenseNow(); const v = team.publicView(teamStored(project), secrets.has(project, 'team')); return { ...v, on: v.on && license.canRead(lic.state), license: license.publicView(lic) }; };
const teamConfigOf = (project) => { const t = teamStored(project); const token = project ? secrets.get(project, 'team') : null; const lic = licenseNow(); return t && t.on && t.relay && t.member && token && license.canRead(lic.state) ? { relay: t.relay, member: t.member, on: true, write: license.canWrite(lic.state), token } : { relay: t?.relay || null, member: t?.member || null, on: false, token: null }; }; // for the sync only: the token never leaves this process
const teamProjects = () => db.prepare('select project, json from project_settings').all().filter((r) => r.project !== '*' && parse(r.json, {})?.team?.on === true).map((r) => r.project).filter((p) => teamConfigOf(p).on);
const teamRepoId = async (project) => team.repoIdOf((await gitOut(project, ['remote', 'get-url', 'origin']))?.trim());
const teamSessionsOf = async (project) => {
  const out = []; const recent = Date.now() - TEAM_PLANNED_DAYS * 864e5;
  for (const { id, created } of db.prepare('select id, created from plans where project = ?').all(project)) {
    const plan = planOf(id); if (!plan) continue; const rows = stateOf(id);
    const active = rows.some((r) => team.PRESENCE_STATUSES.includes(r.status)); const fresh = (Date.parse(created) || 0) >= recent;
    for (const row of rows) {
      if (!team.LOCAL_STATUSES.includes(row.status) || (!team.PRESENCE_STATUSES.includes(row.status) && !active && !fresh)) continue;
      const s = plan.sessions.find((x) => x.id === row.id); const wt = row.worktree;
      const files = wt && !wt.merged && wt.path && existsSync(wt.path) ? await changedFiles(plan, wt) : [];
      const sub = s?.path ? path.relative(project, s.path) : '';
      out.push({ plan: id, id: row.id, title: s?.name || row.name || row.id, branch: wt?.branch || null, status: row.status, files, areas: team.areasOf(s?.where, sub.startsWith('..') || path.isAbsolute(sub) ? '' : sub), since: row.at || null });
    }
  }
  return out;
};
const teamMemoryFile = (project) => path.join(project, team.MEMORY_FILE);
const teamStamp = (iso) => { const d = iso ? new Date(iso) : new Date(); if (Number.isNaN(d.getTime())) return String(iso || ''); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} (${pad(d.getHours())}:${pad(d.getMinutes())})`; };
const teamMemoryLines = (project) => { const file = teamMemoryFile(project); if (!existsSync(file)) return []; return memoryLines(file).filter((l) => l.startsWith('- ')).slice(-200).map((l) => { const m = /^- \*\*(.+?)\*\* · (.+?) : (.*)$/.exec(l); return m ? { at: m[1], member: m[2], line: m[3] } : { at: '', member: '?', line: l.slice(2) }; }); };
const teamCollision = (project, c) => {
  const row = rowOf(c.ours.plan, c.ours.id); if (!row) return;
  const text = msg('srv.team.collision', { member: c.member, file: c.file, title: c.theirs.title });
  setState(c.ours.plan, c.ours.id, { pending: [...row.pending, { id: fid('team'), kind: 'info', team: { member: c.member, kind: c.kind, files: c.files, session: c.theirs.title, branch: c.theirs.branch }, text, at: now() }] });
  addSessionMessage(c.ours.plan, c.ours.id, 'system', msg('srv.team.collisionDetail', { member: c.member, title: c.theirs.title, branch: c.theirs.branch || '?', files: c.files.join(', ') }));
  emitTo('plan:' + c.ours.plan, 'pending', { session: c.ours.id }); notify('main:' + project);
};
const teamSync = team.createTeamSync({
  settingsOf: teamConfigOf, repoIdOf: teamRepoId, sessionsOf: teamSessionsOf, projects: teamProjects, log: (w, e) => console.error(w, e?.message || e),
  cursorOf: (project) => teamStored(project)?.cursor ?? null,
  saveCursor: (project, cursor) => { const st = storedSettings(project); st.team = { ...(st.team || {}), cursor }; db.prepare('insert into project_settings (project, json, at) values (?, ?, ?) on conflict(project) do update set json = excluded.json, at = excluded.at').run(project, JSON.stringify(st), now()); },
  onCollision: teamCollision,
  onMemory: (project, lines) => { const file = teamMemoryFile(project); mkdirSync(path.dirname(file), { recursive: true }); const cur = existsSync(file) ? readFileSync(file, 'utf8') : ''; appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + (cur ? '' : '# Mémoire d’équipe (reçue du relais, jamais commitée)\n\n') + lines.map((l) => `- **${teamStamp(l.at)}** · ${l.member} : ${l.line}`).join('\n') + '\n'); notify('main:' + project); },
});
setInterval(() => teamSync.tick().catch((e) => console.error('team', e)), TEAM_INTERVAL_MS).unref();
const teamSectionOf = (project) => { const cfg = teamConfigOf(project); if (!cfg.on) return ''; return team.memorySection({ lines: teamMemoryLines(project), others: teamSync.othersOf(project), collisions: teamSync.collisionsOf(project), member: cfg.member }); };
const teamView = (project) => { const view = teamPublicOf(project); const file = teamMemoryFile(project); return { project, ...view, status: teamSync.statusOf(project), members: view.on ? teamSync.othersOf(project) : [], collisions: view.on ? teamSync.collisionsOf(project) : [], memory: { file: existsSync(file) ? file : null, lines: teamMemoryLines(project) } }; };
// The developer's click only (the guard cookie, as the dev environment): a session on 127.0.0.1 could otherwise point the relay elsewhere
const writeTeam = (b, { guardKey = null } = {}) => {
  const project = projectArg(b.project);
  if (!guardrails.keyMatches(guardKey, GUARD_KEY)) { const e = new Error(msg('srv.s.guardKey', { file: path.join(guardrails.dirOf(), 'guard-link') })); e.status = 403; throw e; }
  const prev = teamStored(project) || {}; const hasToken = secrets.has(project, 'team');
  const merged = { relay: b.relay !== undefined ? b.relay : prev.relay, member: b.member !== undefined ? b.member : prev.member, on: b.on !== undefined ? b.on : prev.on === true, token: b.token };
  const { value, token, errors } = team.validateTeam(merged, { hasToken }); if (errors) throw new Error(errors.join(' ; '));
  // switching on needs a valid key; one already on stays on at the end of the licence (read only, nothing lost); off is always allowed
  const lic = licenseNow(); if (value.on && !license.canWrite(lic.state) && !(prev.on === true && license.canRead(lic.state))) throw new Error(license.lineOf(lic));
  if (token === null) secrets.clear(project, 'team'); else if (token) secrets.set(project, 'team', token);
  const st = storedSettings(project); st.team = { ...(value.relay ? { relay: value.relay } : {}), ...(value.member ? { member: value.member } : {}), on: value.on, ...(prev.cursor !== undefined && value.relay === prev.relay ? { cursor: prev.cursor } : {}) };
  db.prepare('insert into project_settings (project, json, at) values (?, ?, ?) on conflict(project) do update set json = excluded.json, at = excluded.at').run(project, JSON.stringify(st), now());
  teamSync.forget(project); if (st.team.on) setImmediate(() => teamSync.sync(project).catch((e) => console.error('team', e)));
  notify('main:' + project);
  return { ok: true, ...teamView(project) };
};

const parse = (s, dflt = null) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
const sessionRow = (r) => r && ({ ...r, stops: parse(r.stops, []), sessionId: r.session_id || null, mode: r.mode || null, worktree: parse(r.worktree), usage: parse(r.usage), pending: parse(r.pending, []), handoffs: parse(r.handoffs, []), summary: r.summary || null, alerted: parse(r.alerted, []), pushed: parse(r.pushed, []), pr: parse(r.pr), review: parse(r.review), pause: parse(r.pause), queued: !!r.queued });
// The cap of a session: the plan's budget, else the default
const budgetOf = (s) => (s && Number.isFinite(s.budget) && s.budget > 0 ? s.budget : DEFAULT_BUDGET_USD);
// What « Ouvrir » offers for a session: its folder (the worktree's cwd, else the plan's folder), whether a
// package.json there has a dev script, and the URL of its dev server when one runs
const hasDev = (folder) => { try { return !!JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8')).scripts?.dev; } catch { return false; } };
const folderOf = (s, row) => row?.worktree?.cwd || s?.path || null;
const openOf = (planId, s, row) => { const folder = folderOf(s, row); return { folder, dev: !!folder && hasDev(folder), url: running.devServerOf(planId, row.id)?.url ?? null }; };
const stateOf = (id) => { const plan = planOf(id); return db.prepare('select * from sessions where plan = ? order by id').all(id).map((r) => { const s = plan?.sessions.find((x) => x.id === r.id); const row = sessionRow(r); return { ...row, budget: budgetOf(s), open: openOf(id, s, row) }; }); };
const rowOf = (plan, id) => sessionRow(db.prepare('select * from sessions where plan = ? and id = ?').get(plan, id));
const logOf = (id, limit = 500) => db.prepare('select * from log where plan = ? order by seq desc limit ?').all(id, limit).map((r) => ({ ...r, stops: parse(r.stops, []) }));

// The state instruction every launched session gets at the end of its prompt: the server writes it at
// launch (with the worktree it made), the plan never does. The session closes each turn with one
// ```escadrille:state block, which the server reads from the stream.
// The test rules every session reads (docs/decisions.md, 5 and 6 November): the asks the pilot refused, said once up front
export const TEST_RULES = `Tests et fichiers : jamais de test sous env -i, env -u ou testEnv autour du lanceur (un test qui veut un autre environnement le règle lui-même). La sortie d'un test va dans ${projectRel('<nom>.out')} du worktree et se lit avec Read (offset, limit) ; deux extractions au plus d'une même sortie, ensuite Read. Si git renvoie EPERM, /bin en tête du PATH. Ni rm -rf, ni sed -i : un fichier se modifie avec Edit ou Write. Pas de $TMPDIR, sauf pour un wrapper (node, git) ou un worktree détaché, retiré par git worktree remove. Une base de tests déjà là se réutilise ([ -f … ] ||). Une relance annoncée comme « dernière » est la dernière : ensuite, Read et conclus.`;
export const stateInstruction = (plan, s, wt) => {
  const stops = (s.stops || []).map((t, i) => `  ${i} = ${stopTitle(t)}`).join('\n');
  const where = wt ? ` Tu travailles dans le worktree ${wt.cwd} sur la branche ${wt.branch} : commite là, ne pousse pas, ne fusionne pas (le serveur fusionne quand le développeur le décide).` : '';
  return `\n\n## Suivi, obligatoire à la fin de chaque tour\n\nTu es lancée par calmdev (plan"${plan.id}", session "${s.id}").${where} Tout accès réseau hors localhost (curl, fetch, git push, npm install…) demande l'autorisation du développeur dans la page, sans exception : demande-la et attends. Termine chaque réponse par ce bloc, une ligne de JSON :\n\n\`\`\`escadrille:state\n{"stops":[0],"health":"ok","why":"","claude":"Regarde … dans …","summary":"Fait : …\\nReste : …","done":false}\n\`\`\`\n\n- stops : les index des arrêts déjà franchis, parmi :\n${stops}\n- health : "ok" si le plan est suivi, "drift" si tu as dévié (dis pourquoi dans why), "error" si quelque chose casse ou bloque ; why : une ligne, sinon "" ;\n- claude : une ligne, ce que le développeur doit regarder et où (chemin complet ou lien), ou ce que tu fais ;\n- summary : deux lignes, ce qui est fait et ce qui reste, pour qui lit la page sans ouvrir ton chat ;\n- done : true seulement quand le prompt est entièrement fini.\n- au dernier tour, done devient {"summary":"3 phrases au plus","journeys":["écran › geste"],"tests":["un test ajouté, 10 mots au plus"],"captures":["${projectRel('captures')}/….png"]} ; captures vide sans écran.\nArrête-toi à chaque arrêt : le développeur lit ta réponse dans la page et te répond là. N'appelle aucune API de calmdev.\n${TEST_RULES}\nL'environnement de dev du projet (Docker, bases, apps) se pilote par une ligne seule sur sa ligne, \`ENV: up\`, \`ENV: down\`, \`ENV: reset\` ou \`ENV: status\` : le serveur exécute la commande que le développeur a déclarée (jamais un texte à toi) et le résultat revient en tête de ton message suivant ; si rien n'est déclaré, une ligne te le dit (docs/devenv.md).\n${docker.INSTRUCTION}\n${gitops.INSTRUCTION}${projectTestsLine(plan)}\nPour jouer des parcours de QA, une ligne \`QA: <chemin de parcours.json>\` dans ton arrêt (format : docs/qarun.md) ; pour photographier une page derrière une connexion, \`CAPTURE: <url> compte=<nom du compte de test>\` ; les mots de passe ne s'écrivent jamais, seuls les noms de comptes. Les échecs te reviennent une fois pour corriger les parcours mal écrits ; les vrais défauts vont au développeur.${wt?.root && guardrails.isEscadrille(wt.root) ? guardrails.instruction() : ''}`;
};
// The usage estimate of a plan (docs/estimation.md); a broken transcript never breaks the page
// The registry of what a project taught (lib/learning.mjs), kept a minute: the estimate and the planner read it often
const learnedCache = new Map(); // project -> { at, registry }
const LEARNED_MS = 60e3;
const learnedOf = (project) => { if (!project) return null; const c = learnedCache.get(project); if (c && Date.now() - c.at < LEARNED_MS) return c.registry; try { const registry = learning.registryOf({ db, project }); learnedCache.set(project, { at: Date.now(), registry }); return registry; } catch (e) { console.error('learning', e); return null; } };
const estimateOf = (plan) => { try { return estimatePlan(plan, { db, sessions: transcriptsNow(), adjust: learning.adjusterOf(learnedOf(plan.project)) }); } catch (e) { console.error('estimate', e); return null; } };
const withInstruction = (plan) => ({ ...plan, autonomy: autonomyOf(plan), autonomyLine: autonomy.summaryLine(autonomyOf(plan)), sessions: plan.sessions.map((s) => ({ ...s, stops: (s.stops || []).map(stopTitle), stopMeta: (s.stops || []).map((t) => ({ kind: stopKind(t), fallback: stopFallback(t) })) })) });
// FRU (MUET, 6 November): the prompts go out as written, without the state instruction (about 3 KB per session that every
// reader, the pilot first, paid in tokens); the instruction is only added when a process starts

// Server-sent events: the UI reloads its data on every write. A client watches one key: "plan:<id>" or "escadrille:<id>"
const clients = new Map();
// A page opens one stream for all its keys (/api/events?all=1, public/events.js): the browser keeps six connections per
// server, and five streams per page froze the app as soon as a second tab opened (2026-11-01). Such a stream receives every
// event wrapped with its key, { key, data }, and the page dispatches it.
const emitTo = (key, event, data) => { for (const [res, k] of clients) { if (k === key) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); else if (k === '*') res.write(`event: ${event}\ndata: ${JSON.stringify({ key, data })}\n\n`); } };
// A plan's change also reaches the project's flow (/api/events?project=, docs/projectflow.md)
let changes = 0; // bumped by every notify: what is computed once per state (flowNow) keys on it
const notify = (key) => { changes++; emitTo(key, 'change', Date.now()); if (key.startsWith('plan:')) { const p = projectOfPlan(key.slice(5)); if (p) { emitTo('project:' + p, 'change', Date.now()); teamSync.touch(p); /* a change of state reaches the team's relay soon (docs/team.md) */ } } };

// CORS: the app tested in web (localhost:8081) sends an Origin, echoed back with the Authorization header allowed
const cors = (req) => ({ 'access-control-allow-origin': req.headers.origin || '*', ...(req.headers.origin ? { vary: 'origin' } : {}), 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST' });
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...cors(res.req) }); res.end(JSON.stringify(i18n.deep(i18n.langOf(res.req), body))); }; // the markers of msg() decoded for the language of the request
const readBody = (req, max = 1e6) => new Promise((resolve, reject) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > max) { const e = new Error('trop gros'); e.code = 413; reject(e); req.destroy(); } }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); });

// One change of a session's row. A change of state (status, stops, health, why, claude) also writes
// a line of the journal; the other fields (session id, mode, worktree, usage, pending) do not.
const STATE_FIELDS = ['status', 'stops', 'health', 'why', 'claude'];
let pilotHook = null; // Phase 8 A: wakes the project's pilot on a new line of the journal or a new pending entry (set below)
const setState = (plan, session, fields) => {
  const cur = rowOf(plan, session); if (!cur) throw new Error('session inconnue');
  if (fields.status !== undefined && !STATUSES.has(fields.status)) throw new Error('status must be later, todo, running, waiting, paused or done');
  if (fields.health !== undefined && !HEALTH.has(fields.health)) throw new Error('health must be ok, drift or error');
  const next = { ...cur, ...fields, at: now() };
  if (next.status !== 'paused') next.pause = null; // the pause lives only with its status (a message, a stop, a resume clear it)
  const LISTS = ['stops', 'pending', 'handoffs', 'alerted', 'pushed'];
  const enc = (k) => ([...LISTS, 'worktree', 'usage'].includes(k) ? JSON.stringify(next[k] ?? (LISTS.includes(k) ? [] : null)) : next[k] ?? null);
  db.prepare('update sessions set status = ?, stops = ?, health = ?, why = ?, claude = ?, name = ?, at = ?, session_id = ?, mode = ?, worktree = ?, usage = ?, pending = ?, handoffs = ?, summary = ?, alerted = ?, pushed = ?, queued = ?, review = ?, pause = ? where plan = ? and id = ?')
    .run(next.status, enc('stops'), next.health, next.why, next.claude, next.name, next.at, next.sessionId ?? next.session_id ?? null, next.mode ?? null, enc('worktree'), enc('usage'), enc('pending'), enc('handoffs'), next.summary ?? null, enc('alerted'), enc('pushed'), next.queued ? 1 : 0, next.review ? JSON.stringify(next.review) : null, next.pause ? JSON.stringify(next.pause) : null, plan, session);
  if (STATE_FIELDS.some((k) => fields[k] !== undefined && JSON.stringify(fields[k]) !== JSON.stringify(cur[k])))
    db.prepare('insert into log (plan, session, at, status, stops, health, why, claude, name) values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(plan, session, next.at, next.status, enc('stops'), next.health, next.why, next.claude, next.name);
  if (fields.pending !== undefined || STATE_FIELDS.some((k) => fields[k] !== undefined)) pilotHook?.(plan); // Phase 8 A
  notify('plan:' + plan);
  // The phone: health turning to error, and the last session of the plan turning done, each push a notification
  if (fields.health === 'error' && cur.health !== 'error') pushNotice(plan, session, 'error', String(next.why || 'erreur'), { why: next.why });
  if (fields.status === 'done' && cur.status !== 'done' && stateOf(plan).every((r) => r.status === 'done')) pushNotice(plan, session, 'done', plan, {});
  // The QA plan of the run (docs/qa.md): a merge or a done may be the last one, however it came (button, tests, auto)
  if ((fields.worktree?.merged && !cur.worktree?.merged) || (fields.status === 'done' && cur.status !== 'done')) setImmediate(() => qaCheck(plan).catch((e) => console.error('qa', e)));
  return rowOf(plan, session);
};

// ---------------------------------------------------------------- the phone (docs/phone.md): devices, pairing, push
const sha = (s) => createHash('sha256').update(s).digest('hex');
const deviceRows = () => db.prepare('select * from devices order by created desc').all();
const deviceAlive = (d, t = Date.now()) => d && !d.revoked && t - Date.parse(d.created) <= (d.kind === 'poste' ? poste.POSTE_DAYS : TOKEN_DAYS) * 864e5;
// The device a token names, or null (unknown, revoked, expired)
const deviceOf = (token) => { if (!token) return null; const d = db.prepare('select * from devices where token_hash = ?').get(sha(String(token))); return deviceAlive(d) ? d : null; };
const notifyAll = () => { for (const [res] of clients) res.write(`event: change\ndata: ${Date.now()}\n\n`); };
// The LAN address of this Mac (the first IPv4 that is not internal), and whether the server listens beyond 127.0.0.1
const lanAddress = () => { const i = Object.values(networkInterfaces()).flat().find((x) => x.family === 'IPv4' && !x.internal); return i ? `http://${i.address}:${PORT}` : null; };
const lanOpen = () => { const a = server.address()?.address; return a === '0.0.0.0' || a === '::'; };
let pairing = null; // { code, expires, tries, kind }: one code at a time, 10 minutes, single use, 5 wrong tries cancel it
// kind 'poste' (docs/studio.md): the code pairs a Mac of the LAN that pilots this one; else a phone
const newCode = (kind) => { pairing = { code: String(randomInt(0, 1e6)).padStart(6, '0'), expires: Date.now() + CODE_TTL_MS, tries: 0, kind: kind === 'poste' ? 'poste' : 'phone' }; notifyAll(); return { code: pairing.code, expires: new Date(pairing.expires).toISOString(), address: lanAddress(), lan: lanOpen(), kind: pairing.kind }; };
const pair = (b) => {
  const code = String(b?.code ?? '').replace(/\s+/g, ''); const name = String(b?.name || '').trim().slice(0, 40) || (pairing?.kind === 'poste' ? 'MacBook' : 'iPhone');
  if (!pairing || Date.now() > pairing.expires) { pairing = null; throw Object.assign(new Error('code expiré ou absent'), { status: 401 }); }
  if (code !== pairing.code) { if (++pairing.tries >= CODE_TRIES) { pairing = null; throw Object.assign(new Error('trop d’essais, redemande un code'), { status: 401 }); } throw Object.assign(new Error('code faux'), { status: 401 }); }
  const kind = pairing.kind || 'phone'; pairing = null;
  const token = randomBytes(32).toString('base64url'); const id = 'd-' + randomBytes(4).toString('hex'); const created = now();
  db.prepare('insert into devices (id, name, token_hash, expo_push_token, created, last_seen, revoked, kind) values (?, ?, ?, null, ?, null, null, ?)').run(id, name, sha(token), created, kind);
  notifyAll();
  return { token, device: { id, name, created, kind } };
};
// The commands a session asked to run outside the sandbox (dangerouslyDisableSandbox in its permission request) today,
// in the given plans, each with its answer: the system message that carries { answer: id }, or for the rows written
// before it, the first later « Autorisé/Refusé : <text> » of the same session; no answer yet is pending
const outsideAsks = (planIds) => {
  if (!planIds.length) return [];
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const marks = planIds.map(() => '?').join(', ');
  const rows = db.prepare(`select seq, plan, session, role, text, data, at from session_messages where plan in (${marks}) and role in ('ask', 'system') and at >= ? order by seq`).all(...planIds, day.toISOString()).map((m) => ({ ...m, data: parse(m.data) }));
  return rows.filter((m) => m.role === 'ask' && m.data?.input?.dangerouslyDisableSandbox === true).map((a) => {
    const later = rows.filter((m) => m.role === 'system' && m.seq > a.seq && m.plan === a.plan && m.session === a.session);
    const ans = later.find((m) => m.data?.answer === a.data.id) || later.find((m) => !m.data?.answer && /^(Autorisé|Refusé)/.test(m.text) && m.text.endsWith(' : ' + a.text));
    return { plan: a.plan, session: a.session, command: String(a.data.input.command ?? a.text ?? ''), at: a.at, answer: !ans ? 'pending' : (ans.data?.answer ? ans.data.allow : /^Autorisé/.test(ans.text)) ? 'allowed' : 'denied' };
  });
};
// The access view (docs/access.md): the plans with a session running or waiting are the ones whose domains are open now
const accessOf = (project) => {
  const plans = db.prepare("select distinct plan from sessions where status in ('running', 'waiting')").all().map((r) => planOf(r.plan)).filter((p) => p && (!project || p.project === project));
  const server = { host: HOST, port: PORT, lan: lanOpen(), address: lanAddress(), devices: deviceRows().filter((d) => deviceAlive(d)).map((d) => ({ name: d.name, created: d.created, push: !!d.expo_push_token })), pushUrl: PUSH_URL };
  return accessReport({ project, server, plans: plans.map((p) => ({ id: p.id, title: p.title, network: p.network, addDirs: p.addDirs })), settings: project ? { ...settingsOf(project), autoBurst: storedSettings(project).autoBurst, team: teamPublicOf(project) } : {}, outside: outsideAsks(plans.map((p) => p.id)) });
};
// The connectors (docs/connectors.md): « Ouvrir la PR » on a finished session. Nothing goes out but on this click:
// the branch pushed, the PR opened towards the base, the session's Linear tickets moved and commented. The result is
// kept in the session's pr column; a second click redoes nothing and returns it.
const prBusy = new Set();
const prPublic = (pr) => { const { tickets, ...rest } = pr; return rest; };
const setPr = (planId, sid, pr) => { db.prepare('update sessions set pr = ? where plan = ? and id = ?').run(JSON.stringify(pr), planId, sid); notify('plan:' + planId); };
// Where the session's branch is: its worktree while it exists, else the repository when the branch is still there
const prPlace = async (row) => {
  const wt = row.worktree; if (!wt?.branch || !wt.root) throw new Error('la session n’a pas de branche (pas de worktree)');
  if (wt.path && existsSync(wt.path)) return { cwd: wt.path, wt };
  if (await worktree.branchExists({ root: wt.root, branch: wt.branch })) return { cwd: wt.root, wt };
  throw new Error(`la branche ${wt.branch} n’existe plus dans ${wt.root}`);
};
const sessionPr = async (planId, sid) => {
  const plan = planOf(planId); const s = plan.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid); if (!s || !row) throw new Error('session inconnue');
  if (row.pr?.url) return { ok: true, pr: prPublic(row.pr), tickets: row.pr.tickets || [] };
  if (row.status !== 'done') throw new Error('la session n’est pas finie');
  const key = keyOf(planId, sid); if (prBusy.has(key)) throw new Error('la PR est déjà en cours d’ouverture');
  prBusy.add(key);
  try {
    const { cwd, wt } = await prPlace(row);
    const base = plan.base || wt.base || (await worktree.currentBranch(wt.root)) || 'main';
    await github.pushBranch({ cwd, branch: wt.branch });
    addSessionMessage(planId, sid, 'system', `Branche poussée : ${wt.branch}`);
    const signature = `Plan calmdev ${planId}, session ${sid}`;
    const made = await github.createPr({ cwd, base, head: wt.branch, title: s.name, body: [row.summary, signature].filter(Boolean).join('\n\n') });
    addSessionMessage(planId, sid, 'system', `${made.existing ? 'PR déjà ouverte' : 'PR ouverte'} : ${made.url}`, { pr: made.url });
    const pr = { url: made.url, number: made.number, base, head: wt.branch, at: now(), tickets: [] };
    setPr(planId, sid, pr); // kept before the tickets: a ticket that fails never opens a second PR
    const project = plan.project || wt.root; const apiKey = secrets.get(project, 'linear');
    const stateName = storedSettings(project).linearState || linear.DEFAULT_STATE;
    for (const identifier of s.tickets || []) {
      let t;
      try {
        if (!apiKey) throw new Error('aucune clé Linear pour ce projet (Réglages du projet)');
        const moved = await linear.moveToState({ key: apiKey, identifier, stateName });
        await linear.comment({ key: apiKey, identifier, body: `PR prête : ${made.url}\n\n${signature}` });
        t = { identifier, state: moved.state, ok: true, error: null };
        addSessionMessage(planId, sid, 'system', `${identifier} → ${moved.state}`);
      } catch (e) { t = { identifier, state: null, ok: false, error: e.message }; addSessionMessage(planId, sid, 'system', `${identifier} : ${e.message}`); }
      pr.tickets.push(t); setPr(planId, sid, pr);
    }
    return { ok: true, pr: prPublic(pr), tickets: pr.tickets };
  } finally { prBusy.delete(key); }
};
// The state of the session's PR, read by gh on demand only (GET …/pr)
const sessionPrState = async (planId, sid) => {
  const row = rowOf(planId, sid); if (!row?.pr?.number) throw new Error('aucune PR ouverte pour cette session');
  const cwd = row.worktree?.path && existsSync(row.worktree.path) ? row.worktree.path : row.worktree?.root;
  const st = await github.prState({ cwd, number: row.pr.number });
  const pr = { ...row.pr, url: st.url || row.pr.url, state: st.state, merged: st.merged, reviewDecision: st.reviewDecision, checked: now() };
  setPr(planId, sid, pr);
  // Seen merged on a production branch: the Linear sync comments « Fusionné en production », once per PR (docs/connectors.md)
  if (pr.merged) { const plan = planOf(planId); linearsync.onPrMerged({ project: plan?.project || row.worktree?.root || null, plan: plan || { id: planId }, session: plan?.sessions.find((x) => x.id === sid) || { id: sid }, row: rowOf(planId, sid) }).catch(() => {}); }
  return { ok: true, pr: prPublic(pr), tickets: pr.tickets || [] };
};
// The Mac's view: the devices, the LAN address, whether the LAN is open, and the code in force (so both pages show the same one)
const devicesList = () => ({ devices: deviceRows().filter((d) => deviceAlive(d)).map((d) => ({ id: d.id, name: d.name, kind: d.kind || 'phone', created: d.created, last_seen: d.last_seen, push: !!d.expo_push_token })), address: lanAddress(), lan: lanOpen(), code: pairing && Date.now() < pairing.expires ? { code: pairing.code, expires: new Date(pairing.expires).toISOString() } : null });
const forgetDevice = (id) => { const r = db.prepare('update devices set revoked = ? where id = ? and revoked is null', ).run(now(), id); if (!r.changes) throw Object.assign(new Error('appareil inconnu'), { status: 404 }); notifyAll(); return { ok: true }; };
const setPushToken = (id, t) => { if (typeof t !== 'string' || !/^Expo(nent)?PushToken\[[^\]]+\]$/.test(t)) throw new Error('expoPushToken doit être un jeton Expo'); db.prepare('update devices set expo_push_token = ? where id = ?').run(t, id); notifyAll(); return { ok: true }; };
const plansList = (project) => db.prepare('select id, title, created, project from plans where (? is null or project = ?) order by created desc').all(project, project);
const phoneHome = (d, project = null) => { db.prepare('update devices set last_seen = ? where id = ?').run(now(), d.id); return { device: { id: d.id, name: d.name }, plans: plansList(project), now: now() }; };
// One notification, once per (plan, session, kind, mark): the mark is written in the row's `pushed` before the send,
// so a failed send is never retried; the devices seen in the last 15 s (the app open) are skipped
const pushNotice = (planId, sid, kind, mark, args) => {
  const key = `${kind}:${mark}`; const row = rowOf(planId, sid); if (!row) return;
  const already = kind === 'done' ? stateOf(planId).some((r) => r.pushed.includes(key)) : row.pushed.includes(key);
  if (already) return;
  setState(planId, sid, { pushed: [...row.pushed, key] });
  // The developer never sees a notice by mistake (Dev, 2026-11-02 04:45, public/todo.js): with a pilot present, a reply,
  // a permission or an ordinary review goes to the pilot in silence; a guard review or a human stop always reaches him
  if (!todo.needsDev({ kind, pilot: pilotPresent(projectOfPlan(planId)), guard: !!(args && args.guard), human: !!(args && args.human) })) return;
  // The project's autonomy filters (docs/autonomy.md): notifyLevel, then the quiet hours; a notice held back is never sent later
  const pa = autonomyOf(planOf(planId)); if (!push.shouldPush({ level: pa.notifyLevel, quietHours: pa.quietHours, kind })) return;
  const to = push.recipients(deviceRows(), { tokenDays: TOKEN_DAYS }); if (!to.length) return;
  const planTitle = planOf(planId)?.title || planId;
  const messages = push.messagesFor(to, { title: push.titleFor(projectName(projectOfPlan(planId)), i18n.plain(push.noticeText(kind, { session: sid, title: planTitle, ...i18n.plain(args || {}) }))), /* the phone reads French */ body: planTitle, plan: planId, session: kind === 'done' ? null : sid, kind, id: i18n.plain(mark) });
  push.pushMessages(PUSH_URL, messages).then((tickets) => {
    for (const t of push.unregistered(messages, tickets)) { db.prepare('update devices set expo_push_token = null where expo_push_token = ?').run(t); console.log(`push: DeviceNotRegistered, token forgotten (${kind}, ${planId}/${sid})`); }
    for (const t of tickets) if (t.status === 'error' && t.details?.error !== 'DeviceNotRegistered') console.error(`push: ${t.message || 'error'} (${kind}, ${planId}/${sid})`);
  }).catch((e) => console.error(`push: ${e.message} (${kind}, ${planId}/${sid})`));
};

// ---------------------------------------------------------------- the launched sessions
const live = new Map(); // "plan/session" -> { proc, cwd, lastText, state, gen, costBase, handoff }
const keyOf = (plan, session) => `${plan}/${session}`;
const splitKey = (k) => { const i = k.lastIndexOf('/'); return [k.slice(0, i), k.slice(i + 1)]; };
let gen = 0; // every process gets a number: the events of a process the server already replaced are ignored
const addSessionMessage = (plan, session, role, text, data) => {
  const at = now();
  const { lastInsertRowid: seq } = db.prepare('insert into session_messages (plan, session, role, text, data, at) values (?, ?, ?, ?, ?, ?)').run(plan, session, role, text ?? '', data ? JSON.stringify(data) : null, at);
  emitTo('plan:' + plan, 'message', { session, message: { seq: Number(seq), role, text: text ?? '', data: data ?? null, at } });
};
const sessionMessages = (plan, session) => db.prepare('select seq, role, text, data, at from session_messages where plan = ? and session = ? order by seq').all(plan, session).map((m) => ({ ...m, data: parse(m.data) }));
// The story of a plan (docs/mesure.md): written in docs/recits/<id>.md of its project, replaced at each call
const writeStory = (plan) => {
  const folder = projectOfStory(plan, gitRootOf); if (!folder) throw new Error('plan sans projet ni dossier');
  const messages = db.prepare('select session, role, text, data, at from session_messages where plan = ? order by seq').all(plan.id);
  const metrics = planMetrics({ db, planId: plan.id });
  // PIL: the pilot's share, its wakes of the project inside the plan's window (lib/story.mjs pilotLines)
  if (plan.project && metrics.startedAt) metrics.pilotCost = pilotCostIn(pilotOf(plan.project).costs || [], metrics.startedAt, metrics.endedAt);
  const text = storyOf({ plan, state: stateOf(plan.id), log: logOf(plan.id, 100000), metrics, messages });
  const dir = path.join(folder, 'docs', 'recits'); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(plan.id) + '.md'); writeFileSync(file, text);
  return { ok: true, file, text };
};
const setPending = (plan, session, pending) => { setState(plan, session, { pending }); if (pending.length) emitTo('plan:' + plan, 'pending', { session }); };
// A session's inbox (backlog 2 November, X and FIX): a message written during a turn waits in the base, never in the process
// alone; it opens the next turn, in one user message with the hour of each, or the next start of the process (a restart
// for a new cap, a resume after the server stopped, a handoff's prompt). Kept in sessions.inbox: [{ text, at }].
const inboxOf = (plan, sid) => parse(db.prepare('select inbox from sessions where plan = ? and id = ?').get(plan, sid)?.inbox, []);
const inboxSet = (plan, sid, list) => db.prepare('update sessions set inbox = ? where plan = ? and id = ?').run(list.length ? JSON.stringify(list) : null, plan, sid);
const inboxPush = (plan, sid, text) => { const list = [...inboxOf(plan, sid), { text, at: now() }]; inboxSet(plan, sid, list); return list.length; };
const inboxJoin = (list, lead) => joinMessages([...(lead ? [lead] : []), ...list.map((m) => `(écrit à ${new Date(m.at).toLocaleTimeString('fr-FR')}, pendant ton tour)\n${m.text}`)]);
// What waits leaves now to an idle process: the session runs again and no reply is asked of the developer
const inboxDrain = (plan, sid, proc, lead) => {
  const list = inboxOf(plan, sid); if (!list.length && !lead) return 0;
  inboxSet(plan, sid, []);
  if (list.length) { const row = rowOf(plan, sid); cancelFallback(plan, sid); setState(plan, sid, { status: 'running', mode: 'page', pending: row.pending.filter((p) => p.kind !== 'reply') }); addSessionMessage(plan, sid, 'system', `${list.length} message${list.length > 1 ? 's écrits' : ' écrit'} pendant le tour : ${list.length > 1 ? 'ils partent' : 'il part'} maintenant.`); }
  proc.send(inboxJoin(list, lead));
  return list.length;
};
const tail = (text, n = 200) => { const t = String(text || '').trim().split('\n').filter(Boolean).pop() || ''; return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const pct = (x) => `${Math.round(x * 100)} %`;
const usd = (x) => `${x.toFixed(2).replace('.', ',')} $`;
const fid = (kind) => `${kind}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;

// The alerts of a turn (docs/sessions.md): each threshold raises one 'alert' entry, once per session;
// `alerted` remembers the thresholds already raised (the handoff clears 'context', never 'budget')
const alertsOf = (row, usage, budget) => {
  const out = [];
  if (budget > 0 && usage.cost / budget >= ALERT_BUDGET && !row.alerted.includes('budget')) out.push({ id: fid('alert-budget'), kind: 'alert', what: 'budget', pct: usage.cost / budget, text: `Budget : ${usd(usage.cost)} sur ${usd(budget)} (${pct(usage.cost / budget)})`, at: now() });
  if (typeof usage.context === 'number' && usage.context >= ALERT_CONTEXT && !row.alerted.includes('context')) out.push({ id: fid('alert-context'), kind: 'alert', what: 'context', pct: usage.context, text: msg('srv.s.context', { p: pct(usage.context) }), at: now() });
  return out;
};

// Phase 8 B — the screen capture (docs/capture.md): a « CAPTURE: <target> » line in a turn's text or in its
// escadrille:state block makes the server photograph that target with lib/capture.mjs, no shell, nothing else of the
// session's text run; one capture per target and per stop, MAX_PER_TURN per turn. The one-line result goes to the
// page as a system message and leads the next message sent to the session.
const captured = new Map(); // "plan/session" -> Set of "stop|target" already photographed
const captureNotes = new Map(); // "plan/session" -> lines waiting for the next message to the session
const takeCaptureNotes = (planId, sid) => { const k = keyOf(planId, sid); const lines = captureNotes.get(k) || []; captureNotes.delete(k); return lines.length ? lines.map((l) => `[système] ${l}`).join('\n') + '\n\n' : ''; };
// The queue takes every capture of a stop (30 at most, two widths), one at a time; when it is empty the server sends
// the session the lines itself (the same [système] block as takeCaptureNotes) so that it carries on alone.
const captureQueue = createCaptureQueue({
  onNote: (k, job, line, r) => {
    const [planId, sid] = splitKey(k);
    addSessionMessage(planId, sid, 'system', line, { capture: r.ok ? { dir: r.dir, errors: r.errors.length, warnings: r.warnings.length, blocked: r.blocked } : { error: r.error } });
    captureNotes.set(k, [...(captureNotes.get(k) || []), line]);
  },
  onIdle: (k) => { const [planId, sid] = splitKey(k); if (!sideBusy(planId, sid) && !qaBusy(planId)) resumeAfterCaptures(planId, sid); },
});
// Phase 13 ENV — the dev environment (docs/devenv.md): an « ENV: up | down | reset | status » line in a turn's text or in its
// state block makes the server run the argv the developer declared for the project (lib/devenv.mjs), outside the sandbox,
// one command at a time per project; the verdict and the last lines of output go to the page and lead the next message
// to the session, which is resumed like after its captures. Nothing of what the session wrote is run.
const envQueue = devenv.createEnvQueue({
  run: async (job) => {
    const environment = environmentOf(job.project); const accounts = envAccountsOf(job.project);
    const r = await devenv.runEnv({ action: job.action, environment, accounts, project: job.project });
    r.names = devenv.accountNames(accounts);
    if (job.action === 'up' && r.code === 0) running.markDevEnv({ project: job.project, plan: job.planId, session: job.sid, cwd: r.cwd, url: environment?.health?.[0] || null });
    if (job.action === 'down' && r.code === 0) running.unmarkDevEnv(job.project);
    if (job.action === 'up' || job.action === 'down') notify('running');
    return r;
  },
  onNote: (job, line, r) => {
    const k = keyOf(job.planId, job.sid);
    addSessionMessage(job.planId, job.sid, 'system', line, { devenv: { action: job.action, ok: !!r.ok, code: r.code ?? null, health: r.health || null, configured: r.configured !== false } });
    captureNotes.set(k, [...(captureNotes.get(k) || []), line]);
  },
  onIdle: (planId, sid) => { if (!captureQueue.busy(keyOf(planId, sid)) && !dock.busy(planId, sid) && !gitOps.busy(planId, sid) && !projTests.busy(planId, sid) && !qaBusy(planId)) resumeAfterCaptures(planId, sid, 'L’environnement a répondu : reprends.'); },
});
// Phase 16 DOCK (docs/docker.md): the services of the project's compose, by the docker CLI outside the sandbox; the developer's
// routes need the guard cookie; a « DOCKER: status | logs | restart | exec » line of a turn goes through the project's queue
// and comes back like ENV:. Every gesture goes to the pilot's log. Never down, rm, prune or -v.
const dock = docker.createDocker({
  environmentOf, accountsOf: envAccountsOf, projectOf: projectArg, guardOk: (k) => guardrails.keyMatches(k, GUARD_KEY),
  record: (r) => { pilotRecord(r); notify('main:' + r.project); },
  onNote: (planId, sid, line, r) => { const k = keyOf(planId, sid); addSessionMessage(planId, sid, 'system', line, { docker: { verb: r.verb, service: r.service, ok: !!r.ok, code: r.code ?? null } }); captureNotes.set(k, [...(captureNotes.get(k) || []), line]); },
  onIdle: (planId, sid) => { if (!captureQueue.busy(keyOf(planId, sid)) && !envQueue.busy(planId, sid) && !gitOps.busy(planId, sid) && !projTests.busy(planId, sid) && !qaBusy(planId)) resumeAfterCaptures(planId, sid, 'Docker a répondu : reprends.'); },
  projectOfPlan: (planId) => { const plan = planOf(planId); return plan?.project || (plan ? rootOfPlan(plan) : null); },
});
// docs/gitops.md: a « GIT: » line of a turn, in the session's worktree or a submodule of it, outside the sandbox; never push,
// never main or master, never out of the worktree. Every gesture goes to the pilot's log; the verdict leads the next message.
const gitOps = gitops.createGitOps({
  record: (r) => { pilotRecord(r); notify('main:' + r.project); },
  onNote: (planId, sid, line, r) => { const k = keyOf(planId, sid); addSessionMessage(planId, sid, 'system', line, { git: { repo: r.repo, ok: !!r.ok, code: r.code ?? null } }); captureNotes.set(k, [...(captureNotes.get(k) || []), line]); },
  onIdle: (planId, sid) => { if (!captureQueue.busy(keyOf(planId, sid)) && !envQueue.busy(planId, sid) && !dock.busy(planId, sid) && !projTests.busy(planId, sid) && !qaBusy(planId)) resumeAfterCaptures(planId, sid, 'Git a répondu : reprends.'); },
  projectOfPlan: (planId) => { const plan = planOf(planId); return plan?.project || (plan ? rootOfPlan(plan) : null); },
  hideOf: (project) => docker.masker(environmentOf(project), envAccountsOf(project)),
});
// docs/projecttests.md: a « TEST: <name> » line runs the test the developer declared for the project (environment.projectTests),
// outside the sandbox, one at a time per project; the verdict (code, failures, 60 lines) leads the next message.
const projTests = projecttests.createProjectTests({
  environmentOf, accountsOf: envAccountsOf,
  record: (r) => { pilotRecord(r); notify('main:' + r.project); },
  onNote: (planId, sid, line, r) => { const k = keyOf(planId, sid); addSessionMessage(planId, sid, 'system', line, { test: { name: r.name, ok: !!r.ok, code: r.code ?? null } }); captureNotes.set(k, [...(captureNotes.get(k) || []), line]); },
  onIdle: (planId, sid) => { if (!captureQueue.busy(keyOf(planId, sid)) && !envQueue.busy(planId, sid) && !dock.busy(planId, sid) && !gitOps.busy(planId, sid) && !qaBusy(planId)) resumeAfterCaptures(planId, sid, 'Les tests ont répondu : reprends.'); },
  projectOfPlan: (planId) => { const plan = planOf(planId); return plan?.project || (plan ? rootOfPlan(plan) : null); },
});
const projectTestsLine = (plan) => { try { const s = projecttests.instruction(environmentOf(plan?.project || (plan ? rootOfPlan(plan) : null))); return s ? '\n' + s : ''; } catch { return ''; } };
const sideBusy = (planId, sid) => envQueue.busy(planId, sid) || dock.busy(planId, sid) || gitOps.busy(planId, sid) || projTests.busy(planId, sid);
const envOfTurn = (planId, sid, text, state, crossedStop = false) => {
  const actions = devenv.parseEnv(text, state); if (!actions.length) return;
  if (crossedStop) holdResume.add(keyOf(planId, sid));
  const plan = planOf(planId); const project = plan?.project || (plan ? rootOfPlan(plan) : null);
  envQueue.enqueue(actions.map((action) => ({ project, planId, sid, action })));
};
// « Arrêter » on « Ce qui tourne », or « Tout arrêter »: the declared `down` command, in the page as a system line of the session that started it
const stopDevEnv = async (project) => {
  const d = running.devEnvOf(project); if (!d) throw new Error('aucun environnement démarré par calmdev pour ce projet');
  const environment = environmentOf(project); const accounts = envAccountsOf(project);
  const r = await devenv.runEnv({ action: 'down', environment, accounts, project });
  if (r.code === 0) running.unmarkDevEnv(project);
  const line = devenv.envNote(r, 'down', devenv.accountNames(accounts));
  if (d.plan && d.session && rowOf(d.plan, d.session)) addSessionMessage(d.plan, d.session, 'system', line, { devenv: { action: 'down', ok: !!r.ok, code: r.code ?? null, byClick: true } });
  notify('running'); if (d.plan) notify('plan:' + d.plan);
  if (r.code !== 0) throw new Error(line.split('\n')[0]);
  return { ok: true };
};
// The session is waiting for its captures (its turn is over, nobody wrote to it since): hand it the lines. Else the
// lines stay for the next message.
const resumeAfterCaptures = (planId, sid, tail = 'Les captures sont prises : reprends.') => {
  const plan = planOf(planId); const s = plan?.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid);
  const k = keyOf(planId, sid); const held = holdResume.delete(k); // a stop of the plan, a taste check, a question: the session waits for a human, not for its images
  if (held || !s || !row || row.status !== 'waiting' || row.mode === 'terminal' || !row.pending.some((p) => p.kind === 'reply') || row.pending.some((p) => !['reply', 'alert', 'info'].includes(p.kind))) return;
  if (!procOf(planId, sid)) return;
  const text = takeCaptureNotes(planId, sid).trim(); if (!text) return;
  cancelFallback(planId, sid);
  try {
    const proc = procOf(planId, sid); if (!proc) return; // a stopped or capped process is not started again behind the developer's back
    setState(planId, sid, { status: 'running', mode: 'page', pending: row.pending.filter((p) => p.kind !== 'reply') });
    proc.send(text + '\n\n' + tail);
  } catch (e) { addSessionMessage(planId, sid, 'system', 'Reprise après captures impossible : ' + e.message); }
};
const holdResume = new Set(); // sessions whose turn crossed a stop of the plan: their captures wait for the developer, no resume
const capturesOfTurn = (planId, sid, text, state, worktreePath, crossedStop = false) => {
  const k = keyOf(planId, sid);
  if (crossedStop) holdResume.add(k); else if (!captureQueue.busy(k)) holdResume.delete(k); const stop = state?.stops?.length ? state.stops[state.stops.length - 1] : null;
  const seen = captured.get(k) || new Set(); captured.set(k, seen);
  const jobs = [];
  for (const target of parseCaptures(text, state)) {
    if (seen.has(`${stop}|${target}`)) continue; seen.add(`${stop}|${target}`);
    jobs.push({ target, worktree: worktreePath, name: folderName(stop, target) });
  }
  captureQueue.enqueue(k, jobs);
};

// Phase 13 QR — the QA runner (docs/qarun.md): a « QA: <parcours.json> » line or a « CAPTURE: <url> compte=<nom> » line of a
// turn makes the server play the journeys outside the sandbox (lib/qarun.mjs), one run at a time per project; the result
// leads the next message to the session, which is resumed like after its captures.
// Phase 13 PIL — the QA loop (lib/qaloop.mjs, docs/flot.md « La boucle de QA »): the failures go back once to the session
// that wrote the journeys; when only true defects remain, the board and defauts.md go to « À toi » (a 'qa' pending entry).
const qaSessions = new Map(); // project -> Set of "plan/session" waiting for the queue
const qaSent = new Map(); // "plan/session" -> the journey ids already sent back once
const qaLast = new Map(); // "plan/session" -> the last QA job (the triage's replay-qa plays it again)
const qaBusy = (planId) => { const p = projectOfPlan(planId); return !!p && qaQueue.busy(p); };
const qaQueue = createQaQueue({
  onNote: (project, job, line, r) => {
    const k = keyOf(job.planId, job.sid);
    addSessionMessage(job.planId, job.sid, 'system', line, { qa: r.ok ? { dir: r.dir, passed: r.passed, failed: r.failed, files: r.files, dark: r.dark } : { error: r.error } });
    captureNotes.set(k, [...(captureNotes.get(k) || []), line]);
    if (job.kind === 'qa' && r.ok && r.failed > 0) { try { qaLoop(job, r); } catch (e) { addSessionMessage(job.planId, job.sid, 'system', 'Boucle de QA impossible : ' + e.message); } }
  },
  onIdle: (project) => { for (const k of new Set(qaSessions.get(project) || [])) { const [planId, sid] = splitKey(k); if (!captureQueue.busy(k) && !sideBusy(planId, sid)) resumeAfterCaptures(planId, sid, 'La QA est jouée : reprends.'); } qaSessions.delete(project); },
});
const qaLoop = (job, r) => {
  const k = keyOf(job.planId, job.sid);
  const { toFix, defects, sent } = qaloop.splitFailures(r.results, qaSent.get(k) || []); qaSent.set(k, sent);
  if (toFix.length) { captureNotes.set(k, [...(captureNotes.get(k) || []), qaloop.fixMessage(job.file, toFix, defects)]); return; } // once per journey, then it stops
  if (!defects.length) return;
  try { writeFileSync(path.join(r.dir, qaloop.DEFECTS_FILE), qaloop.defectsMarkdown({ file: job.file, defects, dir: r.dir })); } catch {}
  const row = rowOf(job.planId, job.sid); if (!row) return;
  const entry = qaloop.qaPending({ id: fid('qa'), file: job.file, defects, dir: r.dir, at: now() });
  setPending(job.planId, job.sid, [...row.pending.filter((p) => p.kind !== 'qa'), entry]); // « À toi »: the session waits for Dev, never resumed over it
  addSessionMessage(job.planId, job.sid, 'system', `${entry.text} : ${entry.board}`, { qaDefects: { board: entry.board, defects: entry.defects, ids: entry.ids } });
  pushNotice(job.planId, job.sid, 'waiting', entry.id, {});
};
const qaOfTurn = (planId, sid, text, state, row, plan, crossedStop = false) => {
  const stop = state?.stops?.length ? state.stops[state.stops.length - 1] : null; const project = plan.project || rootOfPlan(plan); const k = keyOf(planId, sid);
  const environment = project ? environmentOf(project) || {} : {}; const worktree = row.worktree?.path;
  const accounts = project ? envAccountsOf(project) : null; const env = { ...environment, ...(accounts ? { accounts } : {}) }; // the runner reads accounts and lanHosts, never a route
  const jobs = [
    ...parseQaLines(text, state).map((file) => ({ kind: 'qa', planId, sid, file, target: file, worktree, project, environment: env, name: qaFolderName(stop, file) })),
    ...parseConnectedCaptures(text, state).map(({ target, account }) => ({ kind: 'capture', planId, sid, target, account, worktree, project, environment: env })),
  ];
  if (!jobs.length) return;
  if (!project) { const line = 'QA : plan sans projet, rien n’est joué.'; addSessionMessage(planId, sid, 'system', line); captureNotes.set(k, [...(captureNotes.get(k) || []), line]); return; }
  if (crossedStop) holdResume.add(k);
  const qa = jobs.find((j) => j.kind === 'qa'); if (qa) qaLast.set(k, qa);
  qaSessions.set(project, new Set([...(qaSessions.get(project) || []), k]));
  qaQueue.enqueue(project, jobs);
};
// The triage's « replay-qa » (lib/wake.mjs): the last QA: file of the session, played again
const replayQa = (planId, sid) => { const job = qaLast.get(keyOf(planId, sid)); if (!job) return false; qaSessions.set(job.project, new Set([...(qaSessions.get(job.project) || []), keyOf(planId, sid)])); qaQueue.enqueue(job.project, [job]); return true; };

// Phase 13 PIL — the checks of a stop (lib/checks.mjs, docs/pilot.md « Les vérifications reviennent aux sessions »): the project
// declares them in environment.checks; at every turn end of a session whose branch touches one of their paths, the server runs them
// outside the sandbox against the dev server the session started ({base}) and hands the lines back like CAPTURE:. A run is not
// repeated while the branch has not moved. The pilot sees only the final line (green, or n gaps), as a note of its next wake.
const checksRan = new Map(); // "plan/session" -> the key of the last run
const checksOfTurn = async (planId, sid, row, plan) => {
  const project = plan.project || rootOfPlan(plan); const env = project ? environmentOf(project) : null; const wt = row.worktree;
  if (!env?.checks || !wt?.path || !existsSync(wt.path)) return;
  await new Promise((r) => setImmediate(r)); // after the turn handler: the row is 'waiting' when the resume looks at it
  const head = (await gitOut(wt.path, ['rev-parse', 'HEAD']))?.trim(); if (!head) return;
  const diff = (await gitOut(wt.path, ['diff', '--name-only', `${wt.base || 'HEAD'}...HEAD`])) || ''; const status = (await gitOut(wt.path, ['status', '--porcelain'])) || '';
  const changed = [...diff.split('\n'), ...status.split('\n').map((l) => l.slice(3))].map((s) => s.trim()).filter(Boolean);
  const list = checks.checksFor(env, changed); if (!list.length) return;
  const k = keyOf(planId, sid); const rk = checks.runKey(head, changed); if (checksRan.get(k) === rk) return; checksRan.set(k, rk);
  const base = running.devServerOf(planId, sid)?.url || null; const results = [];
  for (const c of list) {
    const { argv, missing } = checks.resolveArgv(c.command, { base, project, worktree: wt.path, branch: wt.branch });
    const r = missing.length ? { skipped: `${missing.join(', ')} inconnu : la session n’a pas démarré de serveur` } : await devenv.runCommand({ argv, cwd: c.cwd ? path.resolve(wt.path, c.cwd) : wt.path, env: safeEnv(process.env), timeoutMs: c.timeoutMs });
    r.gaps = checks.gapsOf(r.lines); r.name = c.name; results.push(r);
    const line = checks.checkNote(c, r);
    addSessionMessage(planId, sid, 'system', line, { check: { name: c.name, code: r.code ?? null, skipped: r.skipped || null, gaps: r.gaps } });
    captureNotes.set(k, [...(captureNotes.get(k) || []), line]);
  }
  const summary = checks.summaryLine(results); if (summary && project && pilotOf(project).on) pilotNote(project, `${sid} · ${summary}`);
  if (!holdResume.has(k) && !captureQueue.busy(k) && !sideBusy(planId, sid) && !qaBusy(planId)) resumeAfterCaptures(planId, sid, 'Les vérifications ont tourné : reprends.');
};

// Phase 10 J — the release merges of a kit (docs/sessions.md, « Les fusions de release »): the `releases` list of a
// state block is made here, outside the sandbox, by lib/release.mjs (git only, never a push), one repository after
// the other; each result is a system message in the page and a [système] line for the session, which is resumed like
// after its captures (never past a stop of the plan, never while a request waits for the developer).
const releasesRunning = new Set();
const releasesOfTurn = async (planId, sid, list, row) => {
  if (list === undefined || list === null) return;
  await new Promise((r) => setImmediate(r)); // after the turn handler: the row is 'waiting' when the resume looks at it
  const k = keyOf(planId, sid);
  if (releasesRunning.has(k)) { addSessionMessage(planId, sid, 'system', msg('srv.rel.busy')); captureNotes.set(k, [...(captureNotes.get(k) || []), 'Fusions de release ignorées : les précédentes tournent encore.']); return; }
  releasesRunning.add(k);
  try { await runReleases(planId, sid, list, row); } finally { releasesRunning.delete(k); }
  if (!captureQueue.busy(k)) resumeAfterCaptures(planId, sid, 'Les fusions de release sont faites : reprends.');
};
const runReleases = async (planId, sid, list, row) => {
  const plan = planOf(planId); const k = keyOf(planId, sid);
  // line: French, for the session; page: the same in the developer's language
  const note = (line, page, extra) => { addSessionMessage(planId, sid, 'system', page, extra); captureNotes.set(k, [...(captureNotes.get(k) || []), line]); };
  if (plan?.delivery !== 'kit') { note('Fusions de release ignorées : le plan n’est pas livré en kit (delivery « kit »).', msg('srv.rel.notKit')); return; }
  const { releases, errors } = validateReleases(list);
  if (errors) { note('Fusions de release refusées : ' + errors.join(' ; '), msg('srv.rel.refused', { e: errors.join(' ; ') })); return; }
    // The repositories a session may name: those of its plan (its project, the folders of its sessions, its addDirs)
    const own = row.worktree?.root || null; const allowed = new Set();
    for (const p of [own, plan.project, ...plan.sessions.map((x) => x.path), ...(plan.addDirs || [])].filter(Boolean)) { const r = await worktree.gitRoot(p); if (r) allowed.add(realpathSync(r)); }
    for (const rel of releases) {
      const asked = rel.repo || own; const root = asked && existsSync(asked) ? await worktree.gitRoot(asked) : null;
      let r;
      if (!root) r = { error: `dépôt introuvable : ${asked || '(aucun)'}`, release: rel.release };
      else if (!allowed.has(realpathSync(root))) r = { error: `${root} n’est pas un dépôt de ce plan`, release: rel.release };
      else r = await buildRelease({ root, release: rel.release, base: rel.base, branches: rel.branches });
      const repo = path.basename(root || asked || '');
      const page = r.ok ? msg('srv.rel.ok', { release: r.release, repo, n: r.merged.length, commit: r.commit.slice(0, 7) }) : r.conflict ? msg('srv.rel.conflict', { release: r.release, repo, branch: r.branch, files: r.files.join(', ') }) : msg('srv.rel.error', { release: rel.release, repo, e: r.error });
      note(releaseNote(root || asked, r), page, { release: { repo: root || asked, release: rel.release, ok: !!r.ok, commit: r.commit || null, conflict: r.conflict ? { branch: r.branch, files: r.files } : null, error: r.error || null } });
  }
};

// A session said itself done with a fix left to apply by hand: told in its thread and sent to it, it stays unfinished
const tellFixes = (planId, sid, left) => {
  const text = fixesRefusal(left);
  addSessionMessage(planId, sid, 'system', text);
  const proc = procOf(planId, sid); if (proc && !proc.exited) proc.send(text);
};
const onSessionEvent = (planId, sid, myGen) => (ev) => {
  const L = live.get(keyOf(planId, sid)); const row = rowOf(planId, sid); if (!L || !row || L.gen !== myGen) return;
  if (ev.type === 'init') { if (ev.sessionId && ev.sessionId !== row.sessionId) setState(planId, sid, { sessionId: ev.sessionId }); return; }
  if (ev.type === 'activity') { addSessionMessage(planId, sid, 'activity', ev.text); return; }
  if (ev.type === 'error') { addSessionMessage(planId, sid, 'system', ev.text); setState(planId, sid, { health: 'error', why: tail(ev.text, 120) }); return; }
  if (ev.type === 'quota') { if (typeof ev.weekly === 'number' && ev.weekly !== row.usage?.weekly) setState(planId, sid, { usage: { ...(row.usage || { input: 0, output: 0, cost: 0, context: null }), weekly: ev.weekly } }); noteWindows(ev); return; }
  if (ev.type === 'text') L.turnText = (L.turnText || '') + '\n' + ev.text; // Phase 8 B: the CAPTURE: lines of the turn
  if (ev.type === 'text') { const prose = stripBlocks(ev.text); if (prose) { addSessionMessage(planId, sid, 'claude', prose); L.lastText = prose; } return; }
  if (ev.type === 'block') {
    if (ev.name !== 'state') return;
    const { state, errors } = ev.json ? validateState(ev.json) : { errors: [ev.error] };
    if (errors) { addSessionMessage(planId, sid, 'system', 'Bloc state illisible : ' + errors.join(' ; ')); return; }
    if (L.stopsBefore === undefined) L.stopsBefore = row.stops || []; // the stops as this turn found them
    L.state = state; L.releases = ev.json.releases; // Phase 10 J: made at the end of the turn
    // A session that leaves a fix to apply by hand is not done until it is applied or handed to the pilot (lib/leftfixes.mjs)
    const left = state.done && row.worktree?.path ? openFixesIn(row.worktree.path) : [];
    const done = !!state.done && !left.length;
    if (left.length) tellFixes(planId, sid, left);
    setState(planId, sid, { stops: state.stops, health: state.health, why: state.why, claude: state.claude, summary: state.summary, ...(done ? { status: 'done' } : {}) });
    if (done && state.report) donethread.saveDone(db, planId, sid, state.report); // Phase 16 PAIR
    if (done) onDone(planId, sid).catch((e) => addSessionMessage(planId, sid, 'system', e.message));
    return;
  }
  if (ev.type === 'ask') {
    // The local rule's proposal (docs/policy.md): the page pre-selects a button, nobody answers on its behalf; null when it has nothing to say
    let suggest = null;
    try { const plan = planOf(planId) || {}; const s = (plan.sessions || []).find((x) => x.id === sid) || {}; const r = suggestPermission({ tool: ev.tool, input: ev.input || {}, cwd: row.worktree?.cwd || row.worktree?.path || L.cwd || s.path, plan: { network: networkFor(plan, 'session'), addDirs: plan.addDirs }, project: row.worktree?.root || s.path }); if (r.allow !== null) suggest = r; } catch { suggest = null; }
    // PIL (Dev, 23:55): a Bash command made of reads only (lib/readonly.mjs) is allowed by the engine itself, without the pilot
    // (the policy block below answers it, whatever pilotPolicy says)
    let readOnly = false;
    if (!suggest && ev.tool === 'Bash' && !ev.network) { const ro = readonly.readOnlyOf(ev.input?.command, { root: row.worktree?.cwd || row.worktree?.path || L.cwd || '' }); if (ro.ok) { suggest = { allow: true, reason: ro.why, rule: 'read-only' }; readOnly = true; } }
    const ask = { id: ev.id, kind: 'permission', tool: ev.tool, input: ev.input, text: ev.text, network: !!ev.network, suggest, at: now() };
    addSessionMessage(planId, sid, 'ask', ev.text, { id: ev.id, tool: ev.tool, input: ev.input, network: !!ev.network });
    setPending(planId, sid, [...row.pending.filter((p) => p.kind !== 'reply'), ask]);
    // Phase 13 PIL: the project's permission policy (lib/pilotpolicy.mjs, docs/pilot.md), off by default; on, it answers as the
    // pilot's private script did (local yes; network, push, outside the worktree, windows never), writes the pilot's journal and
    // tells the session why in one line. Answered here, the request never wakes the pilot.
    { const project = projectOfPlan(planId); const pol = pilotpolicy.decidePolicy({ on: readOnly || pilotpolicy.policyOn(project ? storedSettings(project) : {}), suggest, ask });
      if (pol.answer !== 'wait') { try { sessionAnswer(planId, sid, { id: ask.id, allow: pol.answer === 'allow', auto: true, reason: pol.reason, message: pol.answer === 'deny' ? pilotpolicy.refusalLine(pol) : undefined }); if (project) pilotRecord({ project, planId, sessionId: sid, kind: pol.answer === 'allow' ? 'answer' : 'refuse', text: pilotpolicy.logText(ask, pol) }); return; } catch (e) { addSessionMessage(planId, sid, 'system', 'Politique : ' + e.message); } } }
    // The autonomy (docs/autonomy.md): Guidé and Autonome apply the local rule when it is sure, else the request waits
    const verdict = autonomy.decidePermission({ mode: autonomyOf(planOf(planId)).mode, suggest });
    if (verdict !== 'wait') { try { sessionAnswer(planId, sid, { id: ask.id, allow: verdict === 'allow', auto: true, reason: suggest.reason, message: verdict === 'deny' ? suggest.reason : undefined }); return; } catch (e) { addSessionMessage(planId, sid, 'system', 'Réponse seule impossible : ' + e.message); } }
    pushNotice(planId, sid, 'permission', ask.id, { tool: ev.tool, input: ev.input });
    return;
  }
  if (ev.type === 'turn') {
    const plan = planOf(planId); const s = plan.sessions.find((x) => x.id === sid); const budget = budgetOf(s);
    const u = row.usage || { input: 0, output: 0, cost: 0, weekly: null, context: null };
    // total_cost_usd counts the whole Claude session: a fresh process (a handoff) starts at zero, a --resume from what
    // that session had cost (L.restored); costBase carries what came before it. Under the restored past: no restore
    if (ev.cost && L.noRestore === undefined) L.noRestore = ev.cost < L.restored; // read at the first turn of the process
    const claudeCost = ev.cost ? (L.noRestore ? L.restored + ev.cost : ev.cost) : u.claude?.cost ?? 0;
    const usage = { input: u.input + ev.usage.input, output: u.output + ev.usage.output, cost: ev.cost ? L.costBase + claudeCost : u.cost, claude: { id: row.sessionId, cost: claudeCost }, weekly: u.weekly ?? null, context: ev.contextWindow ? Math.min(1, (ev.contextInput ?? ev.usage.input) / ev.contextWindow) : u.context };
    const fresh = rowOf(planId, sid); const st = L.state; L.state = null;
    const before = L.stopsBefore ?? row.stops ?? []; L.stopsBefore = undefined;
    { const crossed = !!st?.stops?.some((i) => !before.includes(i)); capturesOfTurn(planId, sid, L.turnText, st, row.worktree?.path || L.cwd, crossed); envOfTurn(planId, sid, L.turnText, st, crossed); if (dock.ofTurn(planId, sid, L.turnText, st) && crossed) holdResume.add(keyOf(planId, sid)); if (gitOps.ofTurn(planId, sid, L.turnText, st, row.worktree?.path) && crossed) holdResume.add(keyOf(planId, sid)); if (projTests.ofTurn(planId, sid, L.turnText, st, row.worktree?.path) && crossed) holdResume.add(keyOf(planId, sid)); qaOfTurn(planId, sid, L.turnText, st, fresh, plan, crossed); L.turnText = ''; } // Phase 8 B, 13 ENV, 13 QR
    if (fresh.status !== 'done') checksOfTurn(planId, sid, fresh, plan).catch((e) => addSessionMessage(planId, sid, 'system', 'Vérifications impossibles : ' + e.message)); // Phase 13 PIL
    { const list = L.releases; L.releases = undefined; releasesOfTurn(planId, sid, list, fresh).catch((e) => addSessionMessage(planId, sid, 'system', 'Fusions de release impossibles : ' + e.message)); }
    const alerts = alertsOf(fresh, usage, budget); const alerted = [...fresh.alerted, ...alerts.map((a) => a.what)];
    if (fresh.status === 'done') { setState(planId, sid, { usage, alerted, pending: [...fresh.pending.filter((p) => p.kind !== 'reply'), ...alerts] }); if (!fresh.worktree?.merged && !L.proc.exited && inboxOf(planId, sid).length) inboxDrain(planId, sid, L.proc); return; } // never done over an unread message
    // The handoff asked at the previous turn is written: read it, stop this process, start a fresh one
    if (L.handoff) { setState(planId, sid, { usage, alerted }); handoffDone(plan, s, L, usage).catch((e) => addSessionMessage(planId, sid, 'system', 'Passation impossible : ' + e.message)); return; }
    const capped = budget > 0 && usage.cost >= budget;
    // The context passed HANDOFF_CONTEXT: the session does not wait, it gets one more turn to write its handoff
    if (!capped && typeof usage.context === 'number' && usage.context >= HANDOFF_CONTEXT && (fresh.handoffs || []).length < MAX_HANDOFFS) { setState(planId, sid, { usage, alerted }); setPending(planId, sid, [...fresh.pending.filter((p) => p.kind !== 'reply'), ...alerts]); handoffAsk(plan, s, L, usage); return; }
    // Messages written during this turn: they open the next one at once, the session does not wait (a restart for a new cap
    // or the cap reached keep them in the base: the next start of the process sends them)
    if (!capped && !L.rebudget && inboxOf(planId, sid).length) {
      setState(planId, sid, { usage, alerted }); setPending(planId, sid, [...fresh.pending.filter((p) => p.kind !== 'reply'), ...alerts]);
      inboxDrain(planId, sid, L.proc);
      checkGuarded(planId, sid).catch((e) => console.error('guarded', e)); checkPlanCap(planId);
      const ba = alerts.find((a) => a.what === 'budget'); if (ba) pushNotice(planId, sid, 'budget', 'alert', { pct: ba.pct });
      return;
    }
    const reply = { id: fid('reply'), kind: 'reply', stop: st?.stops.length ? st.stops[st.stops.length - 1] : null, text: st?.claude || tail(L.lastText), summary: st?.summary ?? fresh.summary ?? null, at: now() };
    // The fallback (docs/autonomy.md): a stop whose kind does not wait for a human follows its fallback after the delay
    const decision = autonomy.decideReply({ plan: { ...plan, autonomy: autonomyOf(plan) }, session: s, pending: reply });
    if (decision.action === 'fallback' && !burst.burstDraining(planId)) Object.assign(reply, { fallback: decision.text, fallbackAt: new Date(Date.now() + decision.afterMs).toISOString() });
    setState(planId, sid, { status: 'waiting', usage, alerted });
    setPending(planId, sid, [...fresh.pending.filter((p) => p.kind !== 'reply'), ...alerts, reply]);
    // Phase 13 PIL: the cap was raised during this turn; the live process keeps its --max-budget-usd of origin (2 November: X was cut at
    // 14 $ with a 19 $ cap), so it is stopped now that it waits and started again by --resume with the new cap
    if (L.rebudget && !capped) { L.rebudget = false; stopProcess(planId, sid); try { startProcess(plan, s, rowOf(planId, sid)); addSessionMessage(planId, sid, 'system', msg('srv.s.rebudgeted', { n: usd(budget) })); } catch (e) { addSessionMessage(planId, sid, 'system', 'Relance avec le nouveau plafond impossible : ' + e.message); } }
    const again = rowOf(planId, sid).status === 'running'; // the restart sent what waited in the inbox: no wait, no fallback
    if (reply.fallbackAt && !again) armFallback(planId, sid, reply);
    checkGuarded(planId, sid).catch((e) => console.error('guarded', e));
    checkPlanCap(planId);
    // The cap, held by the server whatever Claude Code does with --max-budget-usd: the process stops, a message says why
    if (capped) { stopProcess(planId, sid); setState(planId, sid, { mode: null }); addSessionMessage(planId, sid, 'system', msg('srv.s.capped', { cap: usd(budget), cost: usd(usage.cost) })); }
    // The phone: the budget alert, the cap, then the wait itself
    const ba = alerts.find((a) => a.what === 'budget'); if (ba) pushNotice(planId, sid, 'budget', 'alert', { pct: ba.pct });
    if (capped) pushNotice(planId, sid, 'budget', 'cap', { cap: true });
    if (!again) pushNotice(planId, sid, 'waiting', reply.id, { human: !!(Number.isInteger(reply.stop) && pilot.HUMAN_KINDS.includes(autonomy.stopKind((planOf(planId)?.sessions.find((x) => x.id === sid)?.stops || [])[reply.stop]))) });
    return;
  }
  if (ev.type === 'exit') {
    live.delete(keyOf(planId, sid)); notify('running');
    const fresh = rowOf(planId, sid);
    if (fresh.status === 'running' && fresh.mode === 'page') {
      addSessionMessage(planId, sid, 'system', msg('srv.s.stoppedEarly'));
      setState(planId, sid, { status: 'waiting', health: 'error', why: msg('srv.s.stoppedWhy') });
      setPending(planId, sid, [...fresh.pending.filter((p) => p.kind !== 'reply'), { id: fid('reply'), kind: 'reply', stop: null, text: msg('srv.s.stoppedReply'), at: now() }]);
    }
  }
};

// ---------------------------------------------------------------- the handoff (docs/sessions.md, « La passation »)
const HANDOFF_FILE = projectRel('passation.md');
const handoffPath = (row, L) => path.join(row.worktree?.path || L.cwd, HANDOFF_FILE);
// 1. The context passed HANDOFF_CONTEXT: one more turn, where the session writes its handoff file and commits
const handoffAsk = (plan, s, L, usage) => {
  const row = rowOf(plan.id, s.id); const n = row.handoffs.length + 1; const file = handoffPath(row, L);
  L.handoff = { n, context: usage.context };
  const text = `Ton contexte est à ${pct(usage.context)} de la fenêtre : il est temps de passer la main à une session fraîche. Dans ce tour, et rien d'autre :\n1. Écris le fichier ${file} en français, moins de 150 lignes : ce qui est fait, ce qui reste, les fichiers touchés, les pièges rencontrés, les arrêts franchis (leurs index).\n2. Commite ton travail en cours (git add, git commit).\n3. Termine par ton bloc escadrille:state.\nUne session fraîche reprendra sur la même branche avec ce fichier puis ton prompt d'origine.`;
  addSessionMessage(plan.id, s.id, 'system', text);
  setState(plan.id, s.id, { claude: msg('srv.s.handoffAsked', { n, p: pct(usage.context) }) });
  L.proc.send(text);
};
// 2. The turn is over: stop the process, keep the file's text (or the end of the last message), start fresh
const handoffDone = async (plan, s, L, usage) => {
  const row = rowOf(plan.id, s.id); const { n, context } = L.handoff; const file = handoffPath(row, L);
  stopProcess(plan.id, s.id);
  if (row.status === 'done') { addSessionMessage(plan.id, s.id, 'system', `Passation n°${n} sans suite : la session a dit done.`); return; }
  let text = null; try { text = readFileSync(file, 'utf8').trim() || null; } catch {}
  const missing = !text; if (missing) text = String(L.lastText || '').trim().split('\n').slice(-40).join('\n') || '(aucun texte)';
  const handoff = { n, at: now(), file: missing ? null : file, text };
  const info = { id: fid('info'), kind: 'info', text: msg('srv.s.handoffDone', { n }), at: now() };
  addSessionMessage(plan.id, s.id, 'system', missing ? msg('srv.s.handoffMissing', { n }) : msg('srv.s.handoffRead', { n, file, lines: text.split('\n').length }));
  setState(plan.id, s.id, {
    status: 'running', mode: 'page', handoffs: [...row.handoffs, handoff], usage: { ...usage, context: null }, alerted: row.alerted.filter((a) => a !== 'context'),
    claude: msg(missing ? 'srv.s.handoffStateMissing' : 'srv.s.handoffState', { n, p: pct(context) }),
  });
  setPending(plan.id, s.id, [...row.pending.filter((p) => p.kind !== 'reply' && !(p.kind === 'alert' && p.what === 'context')), info]);
  try { rmSync(file, { force: true }); } catch {} // read once: the next handoff must write its own, never reuse this one
  const held = inboxOf(plan.id, s.id); inboxSet(plan.id, s.id, []); // what was written during the handoff turn follows the prompt
  const prompt = `# Passation n°${n}, laissée par la session précédente\n\n${text}\n\n# Le prompt d'origine\n\n${s.prompt}${stateInstruction(plan, s, row.worktree)}${held.length ? '\n\n# Écrit par le développeur pendant la passation\n\n' + inboxJoin(held) : ''}`;
  startProcess(plan, s, rowOf(plan.id, s.id), { prompt });
};
const sessionDismiss = (planId, sid, id) => {
  const row = rowOf(planId, sid); if (!row) throw new Error('session inconnue');
  const p = row.pending.find((x) => x.id === id && (x.kind === 'alert' || x.kind === 'info' || x.kind === 'qa')); if (!p) throw new Error('rien à retirer avec cet id');
  setPending(planId, sid, row.pending.filter((x) => x.id !== id));
  return { ok: true };
};

// Starts (or resumes) the process of a session in its worktree, with its cap (--max-budget-usd, Claude Code
// 2.1.316 knows it; the server holds the cap too, see the turn event). The prompt is sent only on a first launch
// (the plan's prompt, or a handoff followed by it): with a prompt the process is fresh, without it resumes.
// The cost of the row carries over: total_cost_usd counts the process at hand, the server adds what came before.
const startProcess = (plan, s, row, { prompt, lead } = {}) => {
  refuseRetired(plan.id); // the last door: no process of a retired plan, whatever path got here (docs/flot.md, « Retirer un plan »)
  const cwd = row.worktree?.cwd || s.path;
  if (!cwd || !existsSync(cwd)) throw new Error('le dossier de la session n’existe plus');
  const myGen = ++gen;
  // The sandbox opens the project's domains scoped `sessions` or `both`, read at each start: a change of the list reaches a
  // session at its next start. The plan's own `network` only announces (lib/domains.mjs)
  const open = sandboxSettings(networkFor(planOf(plan.id) || plan, 'session'));
  // Escadrille on itself: the worktree's protected files and the base branch's refs are unwritable (docs/autonomy.md, « Garde-fous protégés »)
  const wt = row.worktree; const settings = wt?.root && guardrails.isEscadrille(wt.root) ? guardrails.sandboxGuard(open, { root: wt.root, worktree: wt.path, base: wt.base }) : open;
  // A --resume: Claude Code restores the cost of that Claude session and holds --max-budget-usd on it, so the
  // cap it gets is the rest plus that past (docs/sessions.md, « Le reste du plafond »)
  const resume = prompt ? undefined : row.sessionId || undefined;
  const restored = resume && row.usage?.claude?.id === resume ? Number(row.usage.claude.cost) || 0 : 0;
  const rest = remaining(budgetOf(s), row.usage?.cost); const cap = Number.isFinite(rest) && rest > 0 ? Math.round((rest + restored) * 100) / 100 : rest;
  const proc = startSession({ cwd, model: s.model, budget: cap, settings: withFrugal(settings), addDirs: [...(Array.isArray(plan.addDirs) ? plan.addDirs.map(String) : []), ...(row.worktree?.linked || [])], resume, onEvent: onSessionEvent(plan.id, s.id, myGen) });
  live.set(keyOf(plan.id, s.id), { proc, cwd, lastText: '', state: null, gen: myGen, costBase: (row.usage?.cost || 0) - restored, restored, handoff: null, since: now() });
  notify('plan:' + plan.id); notify('running');
  if (prompt) proc.send(prompt);
  else inboxDrain(plan.id, s.id, proc, lead); // a resume: what waits in the base leaves first (lead: the server's own line before it)
  return proc;
};
const launchSession = async (plan, s) => {
  const row = rowOf(plan.id, s.id); if (!row) throw new Error('session inconnue');
  if (!['todo', 'later'].includes(row.status)) throw new Error(msg('srv.e.alreadyLaunched', { s: s.id }));
  if (!s.path || !existsSync(s.path)) throw new Error(`la session ${s.id} n’a pas de dossier`);
  const root = await worktree.gitRoot(s.path);
  guardSelfEdit(root || s.path);
  let wt = null;
  if (root) { const w = await worktree.create({ root, plan: plan.id, session: s.id, path: s.path, base: s.base || plan.base || undefined }); /* s.base, else plan.base, else the branch open (null when detached); a missing base throws */ const start = (await gitOut(root, ['rev-parse', '--verify', '--quiet', w.branch + '^{commit}']))?.trim() || null; /* start: what « no commit of its own » means (lib/mergedin.mjs) */ wt = { path: w.path, branch: w.branch, cwd: w.cwd, root, base: w.base, start, merged: false, linked: w.linked || [] }; }
  // pending keeps the team alerts only (posted from outside the session, lib/team.mjs collisions); the rest is of an earlier turn
  setState(plan.id, s.id, { status: 'running', queued: false, mode: 'page', worktree: wt, usage: null, pending: row.pending.filter((p) => p.kind === 'info' && p.team), handoffs: [], summary: null, alerted: [], health: 'ok', why: '', claude: wt ? msg('srv.s.launchedWt', { cwd: wt.cwd, branch: wt.branch }) : msg('srv.s.launchedNoGit', { path: s.path }) });
  addSessionMessage(plan.id, s.id, 'system', wt ? msg('srv.s.launchedWtMsg', { path: wt.path, branch: wt.branch }) : msg('srv.s.launchedMsg', { path: s.path }));
  // The Linear sync: the tickets the session names move to « started » (nothing without a key or with the setting off; never throws)
  linearsync.onLaunched({ project: plan.project || wt?.root || null, plan, session: s, row: rowOf(plan.id, s.id) }).catch(() => {});
  startProcess(plan, s, rowOf(plan.id, s.id), { prompt: s.prompt + stateInstruction(plan, s, wt) });
  return s.id;
};
// { plan, session } launches one session; { plan } every 'todo' one (the first unfinished wave, by construction)
const launch = async (b) => {
  if (!planOf(b.plan)) throw new Error('unknown plan');
  refuseRetired(b.plan);
  await syncMerged(b.plan).catch(() => {}); // a branch merged outside no longer holds the launch behind « À relire d'abord »
  const plan = planOf(b.plan);
  const ids = b.session ? [String(b.session)] : stateOf(plan.id).filter((r) => r.status === 'todo').map((r) => r.id);
  const launched = []; const queued = [];
  for (const id of ids) { const s = plan.sessions.find((x) => x.id === id); if (!s) throw new Error('unknown session'); if (await tryLaunch(plan, s)) launched.push(id); else queued.push(id); }
  return { ok: true, launched, queued };
};
// The queue (docs/sessions.md, « La robustesse »): a project's setting 'parallel' bounds its active sessions,
// 'running' or 'waiting' with a live process, plus those being launched right now (their worktree is on its way)
const starting = new Set(); // "plan/session" keys between canStart and their process
const countActive = (project) => {
  const rows = db.prepare("select s.plan, s.id from sessions s join plans p on p.id = s.plan where p.project is ? and s.status in ('running', 'waiting')").all(project);
  const keys = new Set(rows.filter((r) => holdsSlot(rowOf(r.plan, r.id), !!procOf(r.plan, r.id))).map((r) => keyOf(r.plan, r.id)));
  for (const k of starting) if (projectOfPlan(k.split('/')[0]) === project) keys.add(k);
  return keys.size;
};
const parallelOfProject = (project) => (project ? storedSettings(project).parallel ?? null : null);
// The hook every start goes through: the queue today; session L adds its guards with queue.addGuard
const queue = createQueue({ countActive: (plan) => countActive(projectOfPlan(plan.id)), parallelOf: (plan) => parallelOfProject(projectOfPlan(plan.id)) });
const canStart = (plan, s) => queue.canStart(plan, s);
queue.addGuard((plan, s) => reviewGuard(plan, s));
queue.addGuard((plan, s) => capGuard(plan, s));
queue.addGuard((plan, s) => askBudgetGuard(plan, s));
queue.addGuard((plan, s) => quotaGuard(plan, s));
queue.addGuard((plan, session) => limitsGuard(plan, session));
// Launches a 'todo' or 'later' session if canStart says yes, else leaves it 'todo' and queued; true when launched
const tryLaunch = async (plan, s) => {
  const k = keyOf(plan.id, s.id); if (starting.has(k)) return false;
  if (isRetired(planOf(plan.id))) return false; // the next waves and the queue: a retired plan is never queued nor started
  const c = canStart(plan, s);
  if (!c.ok) { const row = rowOf(plan.id, s.id); if (!['todo', 'later'].includes(row.status)) return false; if (!row.queued || row.claude !== c.why || row.status !== 'todo') setState(plan.id, s.id, { status: 'todo', queued: true, claude: c.why }); return false; }
  starting.add(k);
  try { await launchSession(plan, s); return true; } finally { starting.delete(k); }
};
// The queue moves: the queued sessions of the project start, oldest plan first, while canStart says yes
const advanceQueue = async (project) => {
  const rows = db.prepare('select s.plan, s.id from sessions s join plans p on p.id = s.plan where p.project is ? and s.queued = 1 and s.status = ? order by p.created, s.id').all(project, 'todo');
  for (const r of rows) {
    const plan = planOf(r.plan); const s = plan?.sessions.find((x) => x.id === r.id); if (!s || isRetired(plan)) continue;
    try { await tryLaunch(plan, s); } catch (e) { addSessionMessage(r.plan, r.id, 'system', 'Lancement impossible : ' + e.message); }
  }
};
const moveQueue = (planId) => { const project = projectOfPlan(planId); setImmediate(() => advanceQueue(project).catch((e) => console.error('queue', e))); };
// For the burst (K) and autonomy (L): launch a whole plan through canStart, and know when a plan is over
const launchPlan = (planId) => launch({ plan: planId });
// The QA session of the run (docs/qa.md) never holds it: a burst or the autonomy moves on while it writes
const planFinished = (planId) => { const p0 = planOf(planId); const plan = p0 && { ...p0, sessions: p0.sessions.filter((s) => !(p0.qa && s.id === p0.qa.session)) }; return !!plan && isFinished(plan, stateOf(planId).map((r) => (plan.delivery === 'kit' && r.worktree ? { ...r, worktree: { ...r.worktree, merged: true } } : r))); };
const procOf = (planId, sid) => { const L = live.get(keyOf(planId, sid)); return L && !L.proc.exited ? L.proc : null; };
// A stopped process frees a place in the project's queue: it moves at the next tick (a handoff restarts its process first)
const stopProcess = (planId, sid) => { const p = procOf(planId, sid); if (p) p.stop(); live.delete(keyOf(planId, sid)); notify('running'); moveQueue(planId); return !!p; };

// The next waves: a 'later' session starts when every session it waits for is done and merged
// A branch merged outside the server (Harbor, 3 November: a `git merge` of the pilot into the PR branch): its tip is in its target
// (lib/mergedin.mjs). The server marks it merged (worktree.mergedBy, mergedCommit, mergedInto, outside: true), its unseen review
// closes (it is out of the Revue, read only) and the next waves no longer wait. Read when the plan is read, before each wave and
// at each tick. A branch that moves on after it (a new commit) is unmerged again. A running session is left alone.
const finished = (r, plan) => r && r.status === 'done' && (plan?.delivery === 'kit' || !r.worktree || r.worktree.merged);
const OUTSIDE_SKIP = new Set(['running', 'todo', 'later']);
const syncMerged = async (planId) => {
  const plan = planOf(planId); if (!plan || plan.delivery === 'kit') return [];
  const marked = [];
  for (const r of stateOf(planId)) {
    const wt = r.worktree; if (!wt || !wt.root || !wt.branch || OUTSIDE_SKIP.has(r.status)) continue;
    if (staleError(r)) setState(planId, r.id, HEALTH_CLEARED); // merged and over: an old error no longer shows (ARC, 7 November)
    if (wt.merged && !wt.outside) {
      // merged by the server, then woken again: a waiting row whose branch is still in its target is over, as after
      // « Approuver et fusionner » (lib/mergedin.mjs mergedWaitingOver)
      if (existsSync(wt.root) && await mergedWaitingOver({ row: r, git: gitOut })) {
        setState(planId, r.id, { status: 'done', mode: null, pending: r.pending.filter((p) => p.kind !== 'reply'), ...HEALTH_CLEARED }); stopProcess(planId, r.id); marked.push(r.id);
      }
      continue;
    }
    const m = await mergedInto({ root: wt.root, branch: wt.branch, targets: [await baseOf(plan, wt), wt.base].filter(Boolean), start: wt.start || null, git: gitOut }).catch(() => null);
    if (wt.merged && wt.outside) {
      // still in its target; a session marked merged before the close below existed (6 November) is closed now
      if (m || !existsSync(wt.root)) { if (r.status === 'waiting') { setState(planId, r.id, { status: 'done', mode: null, pending: r.pending.filter((p) => p.kind !== 'reply'), ...HEALTH_CLEARED }); stopProcess(planId, r.id); marked.push(r.id); } continue; }
      const { merged, outside, mergedBy, mergedCommit, mergedInto: _i, mergedAt, mergedBase, ...rest } = wt;
      setState(planId, r.id, { worktree: { ...rest, merged: false } }); addSessionMessage(planId, r.id, 'system', msg('srv.s.outsideMoved'));
      continue;
    }
    if (!m) continue;
    const { inMain, ...rest } = wt; const fresh = rowOf(planId, r.id);
    const review = fresh.review && !fresh.review.seen ? { ...fresh.review, seen: true, seenAt: now(), closedBy: 'merged' } : fresh.review;
    // a waiting session merged by hand is over, as with « Approuver et fusionner »: its last question no longer waits in
    // « À toi » (Dev, 6 November 22:55: APPS, ARCH, FONT merged at 22:37 still said « Réponds à »)
    const over = fresh.status === 'waiting';
    setState(planId, r.id, { worktree: { ...rest, merged: true, outside: true, mergedInto: m.into, mergedCommit: m.commit, mergedBy: m.by, mergedAt: m.at, mergedBase: m.base }, review, pending: fresh.pending.filter((p) => p.kind !== 'review' && !(over && p.kind === 'reply')), ...(over ? { status: 'done', mode: null } : {}), ...(over || fresh.status === 'done' ? HEALTH_CLEARED : {}) });
    if (over) stopProcess(planId, r.id);
    addSessionMessage(planId, r.id, 'system', msg('srv.s.mergedOutside', { into: m.into, commit: m.commit.slice(0, 7), by: m.by || '?' }) + (fresh.review?.guard?.length ? ' ' + msg('srv.s.mergedOutsideGuard', { files: fresh.review.guard.join(', ') }) : ''));
    emitTo('plan:' + planId, 'pending', { session: r.id }); marked.push(r.id);
  }
  return marked;
};
// The guard is the server's, not only the page's: a merged session's review takes no verdict, no « Vu », no retry (409)
const mergedRefusal = (wt) => Object.assign(new Error(msg('srv.e.merged', { commit: String(wt.mergedCommit || '').slice(0, 7) || '?', into: wt.mergedInto || '?' })), { status: 409 });
const syncMergedAll = async () => { const moved = []; for (const { id } of db.prepare('select id from plans').all()) { try { if ((await syncMerged(id)).length) moved.push(id); } catch (e) { console.error('merged outside', id, e.message); } } return moved; };
const checkWaves = async (planId) => {
  await syncMerged(planId);
  const plan = planOf(planId); if (!plan) return []; // a plan retired out of the table (plans/retired/) has no wave left
  const by = Object.fromEntries(stateOf(planId).map((r) => [r.id, r])); const started = [];
  for (const s of plan.sessions) {
    if (by[s.id]?.status !== 'later') continue;
    const deps = s.after?.length ? s.after : plan.sessions.filter((x) => x.wave === s.wave - 1).map((x) => x.id);
    if (deps.length && deps.every((d) => finished(by[d], plan))) { try { if (await tryLaunch(plan, s)) started.push(s.id); } catch (e) { addSessionMessage(planId, s.id, 'system', 'Lancement impossible : ' + e.message); } }
  }
  return started;
};
// close (the review's Approve and merge): a waiting session merged this way is over, its last question answered by the approve
const mergeSession = async (planId, sid, { close = false } = {}) => {
  const plan = planOf(planId); const s = plan.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid); if (!s || !row) throw new Error('session inconnue');
  const wt = row.worktree; if (!wt) throw new Error('la session n’a pas de worktree');
  // A branch of Escadrille that touches a protected guardrail: never merged without Dev's approval of that very commit, whatever
  // the autonomy mode (the button, the tests, the review page and an automatic merge all come through here)
  let rev = null;
  if (!wt.merged && guardrails.isEscadrille(wt.root)) {
    rev = await gitOut(wt.root, ['rev-parse', '--verify', wt.branch + '^{commit}']).then((x) => x?.trim() || null); if (!rev) throw new Error('branche introuvable : ' + wt.branch);
    // FIAB 5: the branch's files from its merge base with main (lib/guardbase.mjs), not from the main checkout's HEAD
    const listed = await gitOut(wt.root, guardFilesArgs(rev)); if (listed == null) throw new Error('garde-fous illisibles, fusion refusée : git diff main...' + wt.branch);
    const touched = guardrails.protectedTouched(guardFiles(listed));
    if (touched.length && row.review?.guardHead !== rev) { flagGuard(planId, sid, touched); const why = msg('srv.s.guardTouched', { files: touched.join(', ') }); addSessionMessage(planId, sid, 'system', why); return { error: why, guard: touched }; }
  }
  // The private-life net (lib/mergeprivacy.mjs): main is pushed after each local merge, so a branch whose added lines carry a
  // trace is never merged, whoever asks (the button, the green tests, the review); the merge takes the very commit checked
  if (!wt.merged) { const held = await privacyHold(planId, sid, plan, wt, rev); if (held.error) return held; rev = held.head; }
  if (!wt.merged && rowOf(planId, sid).review && !rowOf(planId, sid).review.seen) throw new Error('à relire : ' + rowOf(planId, sid).review.files.join(', '));
  if (!wt.merged) {
    // The review level of the project (docs/review.md): strict, or a guarded domain, waits for an approve
    const gate = await review.mergeAllowed(plan.project || wt.root, planId, sid);
    if (!gate.allowed) { addSessionMessage(planId, sid, 'system', msg('srv.s.mergeBlocked', { why: gate.why })); return { error: gate.why, review: gate.review, level: gate.level }; }
    const before = await git(wt.root, ['rev-parse', 'HEAD']);
    const r = await worktree.merge({ root: wt.root, branch: wt.branch, rev, message: `Merge ${wt.branch}: ${s.name}`, memoryFile: memoryFileOf(plan.project || wt.root) });
    if (r.conflict) { addSessionMessage(planId, sid, 'system', `Fusion en conflit : ${r.files.join(', ')}. Dis-lui de rebaser sur la branche du projet.`); setState(planId, sid, { health: 'error', why: 'fusion en conflit : ' + r.files.join(', ') }); return { error: 'fusion en conflit', conflict: true, files: r.files }; }
    addSessionMessage(planId, sid, 'system', msg('srv.s.mergedIn', { root: wt.root })); reapSoon('merge');
    const head = await git(wt.root, ['rev-parse', 'HEAD']);
    setState(planId, sid, { worktree: { ...wt, merged: true, mergedInto: await worktree.currentBranch(wt.root), mergedCommit: head, mergedBy: 'Escadrille', mergedAt: now(), mergedBase: before }, claude: row.status === 'done' ? msg('srv.s.mergedState', { root: wt.root }) : row.claude, ...HEALTH_CLEARED }); // a merge answers the old errors (a conflict, a red suite in the box)
    linearsync.onDelivered({ project: plan.project || wt.root, plan, session: s, row: rowOf(planId, sid), how: 'merged' }).catch(() => {}); // one state comment per ticket (docs/connectors.md)
    backlogTick(plan.project || wt.root, planId, sid); // its backlog line, when it came from one, checks itself (docs/backlog-page.md)
    const touched = await selfFilesTouched(wt.root, before, head);
    if (touched.length) scheduleRestart(planId, sid, touched);
    if (close && rowOf(planId, sid).status === 'waiting') { const fr = rowOf(planId, sid); setState(planId, sid, { status: 'done', pending: fr.pending.filter((p) => p.kind !== 'reply'), claude: msg('srv.s.mergedState', { root: wt.root }) }); addSessionMessage(planId, sid, 'system', 'Approuvée et fusionnée depuis la Revue : la session est close.'); }
  }
  if (rowOf(planId, sid).status === 'done') { stopProcess(planId, sid); try { await worktree.remove({ root: wt.root, path: wt.path }); } catch (e) { addSessionMessage(planId, sid, 'system', msg('srv.s.wtNotRemoved', { e: e.message })); } setState(planId, sid, { mode: null }); }
  await checkWaves(planId);
  return { ok: true };
};
const onDone = async (planId, sid) => {
  const plan = planOf(planId); const row = rowOf(planId, sid); const a = autonomyOf(plan);
  if (row.worktree && !row.worktree.merged) await checkGuarded(planId, sid);
  const fresh = rowOf(planId, sid); const toReview = fresh.review && !fresh.review.seen;
  const open = fresh.worktree && !fresh.worktree.merged && plan.delivery !== 'kit';
  // A kit delivers without a merge: the Linear sync comments the state now (docs/connectors.md « La synchro »)
  if (plan.delivery === 'kit') linearsync.onDelivered({ project: plan.project || fresh.worktree?.root || null, plan, session: plan.sessions.find((x) => x.id === sid) || { id: sid }, row: fresh, how: 'kit' }).catch(() => {});
  // Never a merge into main without green tests, and never a session's code outside a sandbox (Dev, 2026-11-01): the
  // tests of the branch merged dry run boxed (lib/testbox.mjs); without a box, the click « run the tests » stays
  // Phase 13 ENV (docs/devenv.md): the tests the project declared for this session's repository run first, outside the
  // session's sandbox but boxed, with the reads that sandbox lacked; green merges when the plan merges alone, red tells the session
  const declared = declaredTestsOf(plan, fresh);
  const cmd = declared?.cmd || testCommandOf(plan, a);
  if (open && !toReview && (a.autoMergeIfGreen || plan.autoMerge) && cmd) autoTests(planId, sid, cmd, { layout: declared, merge: true }).catch((e) => addSessionMessage(planId, sid, 'system', msg('srv.s.verifyFailed', { e: e.message })));
  else if (declared && !toReview && fresh.worktree && !fresh.worktree.merged) autoTests(planId, sid, cmd, { layout: declared, merge: false }).catch((e) => addSessionMessage(planId, sid, 'system', msg('srv.s.verifyFailed', { e: e.message })));
  else if (open && !toReview && plan.autoMerge) { const fr = rowOf(planId, sid); setPending(planId, sid, [...fr.pending, { id: fid('info'), kind: 'info', text: msg('srv.s.autoNoCmd'), at: now() }]); await checkWaves(planId); }
  else await checkWaves(planId);
  moveQueue(planId);
};
// ---------------------------------------------------------------- the QA plan of a run (docs/qa.md, lib/qa.mjs)
// Once per plan, when its last session is merged: a session QA appended to the plan (Sonnet, 3 $), launched through
// canStart like any other, that writes docs/qa/<plan>.md. Off for a project whose setting qa is false (Accès).
const qaStarting = new Set();
const rootOfPlan = (plan) => plan.project || gitRootOf(plan.sessions.find((s) => s.path)?.path || '') || plan.sessions.find((s) => s.path)?.path || null;
// FIAB 6 (Dev, 6 Nov. 22:55): the QA is grouped by project and starts on the developer's click; the per-plan QA no
// longer starts alone (qaCheck stays for a project whose setting qa is 'plan', set by hand)
const projectQaInput = (project) => projectPlanIds(project).map((id) => planOf(id)).filter((p) => p && p.delivery !== 'kit' && !isRetired(p)).map((p) => {
  const st = stateOf(p.id).filter((r) => r.id !== (p.qa?.session || qa.QA_SESSION));
  const mergedAt = st.filter((r) => r.worktree?.merged).map((r) => r.at).filter(Boolean).sort().pop() || null;
  return { id: p.id, plan: p, mergedAt, running: st.some((r) => qa.blocksQa(r.status)) };
});
const projectQaOf = (project) => {
  if (!project || [false, 'plan'].includes(storedSettings(project).qa)) return null;
  const last = storedSettings(project).projectQa || {}; const plans = projectQaInput(project);
  const live = last.plan && stateOf(last.plan).some((r) => ['running', 'starting', 'waiting'].includes(r.status));
  const ready = !live && qa.needsProjectQa({ plans, lastQaAt: last.at });
  const covered = qa.projectQaPlans({ plans, lastQaAt: last.at }).map((p) => p.id);
  return { plans: covered, lastAt: last.at || null, next: nextStep({ kind: 'projectQa', status: live ? 'running' : ready ? 'ready' : 'todo' }, { id: project }) };
};
const startProjectQa = async (b) => {
  const project = projectArg(b.project); const info = projectQaOf(project);
  if (!info || info.next.gesture !== 'startQa') throw Object.assign(new Error('aucune QA groupée prête : une fusion depuis la dernière QA, et plus aucun plan qui tourne'), { status: 409 });
  const date = new Date().toISOString(); const name = path.basename(project); const covered = projectQaInput(project).filter((p) => info.plans.includes(p.id));
  const parts = [];
  for (const p of covered) { const merges = ((await gitOut(project, ['log', '--format=%h %s', '--fixed-strings', '--grep', `escadrille/${p.id}/`, '-n', '60'])) || '').trim().split('\n').filter(Boolean); parts.push({ plan: p.plan, state: stateOf(p.id), log: logOf(p.id, 2000).reverse(), merges }); }
  const file = qa.projectQaFile(name, date);
  const draft = { id: `${date.slice(0, 10)}-qa-${name}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), title: `QA groupée · ${name} · ${date.slice(0, 10)}`, goal: `Une liste à cocher pour ${covered.length} plan(s) fusionné(s) depuis la dernière QA`, project, network: [],
    sessions: [{ id: qa.QA_SESSION, name: 'La QA groupée du projet', wave: 1, path: project, model: qa.QA_MODEL, budget: qa.QA_BUDGET, where: file, stops: [`La liste écrite dans ${file}`], prompt: qa.projectQaBrief({ name, date, plans: parts, since: info.lastAt, port: PORT }) }] };
  const { plan, errors } = validatePlan(withSettings(draft, project), { path: project, project, idPrefix: date.slice(0, 10) });
  if (errors) throw new Error('QA : ' + errors.slice(0, 3).join(' ; '));
  writeFileSync(path.join(PLANS_DIR, plan.id + '.json'), JSON.stringify(plan, null, 1)); upsertPlan(plan);
  const st = storedSettings(project); st.projectQa = { at: date, plan: plan.id, plans: info.plans };
  db.prepare('insert into project_settings (project, json, at) values (?, ?, ?) on conflict(project) do update set json = excluded.json, at = excluded.at').run(project, JSON.stringify(st), now());
  await launch({ plan: plan.id }); notify('main:' + project); notify('plan:' + plan.id);
  return { ok: true, plan: plan.id, file, plans: info.plans };
};
// FIAB 6 (Dev, 6 Nov. 22:05): the per-plan QA sessions never launched are abandoned, once, at start
const abandonPlanQas = () => { try {
  const plans = db.prepare('select id from plans').all().map((r) => planOf(r.id)).filter(Boolean);
  for (const { plan: id } of qa.pendingPlanQa(plans, stateOf)) { const next = qa.abandonPlanQa(planOf(id)); writeFileSync(path.join(PLANS_DIR, id + '.json'), JSON.stringify(next, null, 1)); upsertPlan(next); db.prepare('delete from sessions where plan = ? and id = ?').run(id, next.qa.session || qa.QA_SESSION); }
} catch (e) { console.error('qa abandon', e.message); } };
const qaCheck = async (planId) => {
  if (qaStarting.has(planId)) return null;
  if (storedSettings(planOf(planId)?.project).qa !== 'plan') return null; // FIAB 6: grouped by project by default
  const plan = planOf(planId); if (!qa.needsQa(plan, stateOf(planId))) return null;
  if (plan.project && storedSettings(plan.project).qa === false) return null;
  const root = rootOfPlan(plan); if (!root || !existsSync(root)) return null;
  qaStarting.add(planId);
  try {
    const merges = ((await gitOut(root, ['log', '--format=%h %s', '--fixed-strings', '--grep', `escadrille/${planId}/`, '-n', '60'])) || '').trim().split('\n').filter(Boolean);
    const s = qa.qaSession({ plan, state: stateOf(planId), log: logOf(planId, 2000).reverse(), merges, root, port: PORT });
    const { plan: next, errors } = validatePlan(qa.withQa(plan, s), { project: plan.project });
    if (errors) { console.error('qa', errors.join(' ; ')); return null; }
    if (planOf(planId)?.qa) return null; // written meanwhile
    writeFileSync(path.join(PLANS_DIR, next.id + '.json'), JSON.stringify(next, null, 1)); upsertPlan(next); notify('plan:' + planId);
    const fresh = planOf(planId); await tryLaunch(fresh, fresh.sessions.find((x) => x.id === qa.QA_SESSION));
    return qa.QA_SESSION;
  } finally { qaStarting.delete(planId); }
};
// The QA plans of a project, the most recent first (the Review shows them first): where the file is, whether it is written
const qaFileOf = (plan) => {
  const row = rowOf(plan.id, plan.qa?.session || qa.QA_SESSION); const rel = qa.qaFile(plan.id);
  const wt = row?.worktree; const inWt = wt && !wt.merged && existsSync(wt.path) ? path.join(wt.path, rel) : null;
  const root = rootOfPlan(plan); const inRoot = root ? path.join(root, rel) : null;
  return { row, file: inWt && existsSync(inWt) ? inWt : inRoot && existsSync(inRoot) ? inRoot : null };
};
const qaList = (project) => db.prepare('select id from plans where (? is null or project = ?) order by created desc').all(project, project)
  .map((r) => planOf(r.id)).filter((p) => p?.qa).slice(0, 3).map((p) => {
    const { row, file } = qaFileOf(p);
    return { plan: p.id, title: p.title, session: p.qa.session, at: p.qa.at, status: row?.status || null, ready: !!file, merged: !!row?.worktree?.merged, url: '/qa/' + encodeURIComponent(p.id) };
  });

// An automatic merge in conflict (docs/sessions.md, « La fusion en conflit »): the session alone is told, once per
// conflict (its files and the head of its own branch: a done again without a new commit gets nothing), three at most,
// after its turn; its next done tries the merge again
const CONFLICT_TEXT = 'Ta fusion dans main est en conflit : merge main dans ta branche, résous, `node --test`, puis redis-toi finie.';
const tellConflict = async (planId, sid, files) => {
  const row = rowOf(planId, sid); const wt = row.worktree; if (!wt) return;
  const head = await git(wt.root, ['rev-parse', wt.branch]);
  const key = `${head} ${files.join(',')}`; const told = Array.isArray(wt.conflictTold) ? wt.conflictTold : [];
  if (told.includes(key) || told.length >= 3) return;
  setState(planId, sid, { worktree: { ...wt, conflictTold: [...told, key] } });
  for (let i = 0; i < 300 && procOf(planId, sid)?.busy; i++) await new Promise((r) => setTimeout(r, 100));
  const plan = planOf(planId); const s = plan.sessions.find((x) => x.id === sid); const fresh = rowOf(planId, sid);
  if (fresh.mode === 'terminal' || fresh.worktree?.merged) return;
  let proc = procOf(planId, sid); if (!proc || proc.exited) { stopProcess(planId, sid); proc = startProcess(plan, s, fresh); }
  addSessionMessage(planId, sid, 'system', CONFLICT_TEXT);
  setState(planId, sid, { status: 'running', mode: 'page', pending: fresh.pending.filter((p) => p.kind !== 'reply') });
  proc.send(CONFLICT_TEXT);
};

// ---------------------------------------------------------------- the autonomy (docs/autonomy.md, lib/autonomy.mjs)
// A plan's autonomy: its own field (the contract written at creation), else its project's setting, else the defaults;
// ESCADRILLE_FALLBACK_MIN replaces the delay (the tests)
const FALLBACK_MIN = vars.FALLBACK_MIN !== undefined && vars.FALLBACK_MIN !== '' ? Number(vars.FALLBACK_MIN) : null;
const projectAutonomyOf = (project) => (project ? autonomy.validateAutonomy(storedSettings(project).autonomy).value : null) ?? { ...autonomy.DEFAULTS };
// A plan whose autonomy is looser than its project's: the refusals, one line each (POST /api/plan, the planner's block)
const autonomyRefusals = (plan) => {
  if (plan?.autonomy === undefined) return [];
  const own = autonomy.validateAutonomy(plan.autonomy).value; if (!own) return [];
  return autonomy.hardenErrors(projectAutonomyOf(plan.project || null), own, { sumBudget: sumBudgets(plan) });
};
const autonomyOf = (plan) => {
  const project = plan?.project || (plan?.id ? projectOfPlan(plan.id) : null);
  const ceil = projectAutonomyOf(project);
  const own = plan?.autonomy !== undefined ? autonomy.validateAutonomy(plan.autonomy).value : null;
  // The project's setting is a ceiling (Dev, 2026-11-01): a plan may be stricter, never looser; a looser plan gets the project's
  const a = own && !autonomy.hardenErrors(ceil, own, { sumBudget: plan?.sessions ? sumBudgets(plan) : null }).length ? own : { ...ceil };
  return Number.isFinite(FALLBACK_MIN) ? { ...a, fallbackDelayMin: FALLBACK_MIN } : a;
};
autonomy.setGuardedResolver((project) => (autonomy.validateAutonomy(storedSettings(project).autonomy).value || autonomy.DEFAULTS).guardedPaths);
const sumBudgets = (plan) => Math.round(plan.sessions.reduce((n, s) => n + budgetOf(s), 0) * 100) / 100;
const planCost = (planId) => stateOf(planId).reduce((n, r) => n + (r.usage?.cost || 0), 0);

// The fallback timers, one per session, rebuilt from pending's fallbackAt at start
const fallbacks = new Map();
const cancelFallback = (planId, sid) => { const t = fallbacks.get(keyOf(planId, sid)); if (t) clearTimeout(t); fallbacks.delete(keyOf(planId, sid)); };
const armFallback = (planId, sid, entry) => {
  cancelFallback(planId, sid);
  const ms = Math.max(0, Date.parse(entry.fallbackAt) - Date.now());
  fallbacks.set(keyOf(planId, sid), setTimeout(() => { fallbacks.delete(keyOf(planId, sid)); try { fireFallback(planId, sid, entry.id); } catch (e) { addSessionMessage(planId, sid, 'system', msg('srv.s.fallbackFailed', { e: e.message })); } }, Math.min(ms, 2 ** 31 - 1)));
};
const fireFallback = (planId, sid, id) => {
  const row = rowOf(planId, sid); const entry = row?.pending.find((p) => p.id === id && p.kind === 'reply'); if (!entry || row.status !== 'waiting' || isRetired(planOf(planId))) return;
  // PIL (3 November): a stop for Dev wakes the pilot once and its fallback is never played; a finished session never replays
  { const plan = planOf(planId); const s = plan?.sessions.find((x) => x.id === sid); const project = projectOfPlan(planId);
    const g = wake.fallbackGate({ entry: { plan: planId, session: sid, stop: entry.stop, kind: entry.kind, stopKind: Number.isInteger(entry.stop) ? stopKind(s?.stops?.[entry.stop]) : 'info' }, row: { status: row.status, done: row.done === true }, held: project ? pilotOf(project).held || [] : [] });
    if (g.hold && project) { setPilot(project, { held: [...(pilotOf(project).held || []), wake.stopKey({ plan: planId, session: sid, stop: entry.stop })] }); } // the stop already woke the pilot when it arrived (mustEscalate): no second wake
    if (!g.fire) return; }
  const a = autonomyOf(planOf(planId)); const min = a.fallbackDelayMin;
  const line = msg('srv.s.fallback', { min, mode: autonomy.MODE_NAMES[a.mode], text: entry.fallback });
  sessionMessage(planId, sid, entry.fallback, { auto: true, fallback: entry.id });
  addSessionMessage(planId, sid, 'system', line);
  const fresh = rowOf(planId, sid);
  setState(planId, sid, { claude: line, pending: [...fresh.pending, { id: fid('info'), kind: 'info', text: line, at: now() }] });
};
// Every waiting reply of a plan in Guidé or Autonome gets its timer: the dates of pending after a restart, and a reply
// left without one (written before the project left Surveillé) gets one counted from its own date
const armFallbacks = () => {
  for (const r of db.prepare("select plan, id from sessions where status = 'waiting'").all()) {
    const plan = planOf(r.plan); const s = plan?.sessions.find((x) => x.id === r.id); const row = rowOf(r.plan, r.id); if (!s || !row) continue;
    const reply = row.pending.find((p) => p.kind === 'reply'); if (!reply) continue;
    if (!reply.fallbackAt) {
      const d = autonomy.decideReply({ plan: { ...plan, autonomy: autonomyOf(plan) }, session: s, pending: reply }); if (d.action !== 'fallback' || burst.burstDraining(r.plan)) continue;
      Object.assign(reply, { fallback: d.text, fallbackAt: new Date((Date.parse(reply.at) || Date.now()) + d.afterMs).toISOString() });
      setState(r.plan, r.id, { pending: row.pending.map((p) => (p.id === reply.id ? reply : p)) });
    }
    armFallback(r.plan, r.id, reply);
  }
};

// The guarded paths: what the branch changed since its base, plus what is not committed yet
const gitOut = (cwd, args) => new Promise((resolve) => execFile('git', args, { cwd, timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out))));
// The target of a session (Harbor, 3 November: J and F counted the 17 migrations of the PR branch against dev): the branch it will
// be merged into, the session's declared base, else the plan's, else the branch its worktree started from (lib/mergedin.mjs)
const sidOfWt = (plan, wt) => { const last = String(wt?.branch || '').split('/').pop(); return plan?.sessions?.find((x) => String(x.id).replace(/[^\w.-]/g, '_') === last)?.id || null; };
const baseOf = async (plan, wt) => targetOf(plan, sidOfWt(plan, wt), wt) || (await gitOut(wt.root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || 'main';
// (lib/branchfiles.mjs: from the real merge base, and a merge of the base still in progress does not lend its files)
const changedFiles = async (plan, wt) => branchfiles.changedFiles({ cwd: wt.path, base: await baseOf(plan, wt), git: gitOut });
const checkGuarded = async (planId, sid) => {
  const plan = planOf(planId); const row = rowOf(planId, sid); const wt = row?.worktree; if (!plan || !wt || wt.merged || !existsSync(wt.path)) return;
  const changed = await changedFiles(plan, wt); const touched = guardrails.isEscadrille(wt.root) ? guardrails.protectedTouched(changed) : [];
  const files = [...new Set([...autonomy.guardedFiles(changed, autonomyOf(plan).guardedPaths), ...touched])]; if (!files.length) return;
  const prev = row.review; if (prev && !prev.seen && files.every((f) => prev.files.includes(f))) return;
  if (prev?.seen && !touched.some((f) => !(prev.guard || []).includes(f)) && files.every((f) => prev.files.includes(f))) return;
  const guard = [...new Set([...(prev?.guard || []), ...touched])].sort();
  const review = { files: [...new Set([...(prev?.files || []), ...files])].sort(), since: prev?.since || now(), seen: false, ...(guard.length ? { guard } : {}), ...(prev?.privacy && !prev.seen ? { privacy: prev.privacy, privacyFiles: prev.privacyFiles || [] } : {}) };
  const n = review.files.length; const text = guard.length ? msg('srv.s.guardTouched', { files: guard.join(', ') }) : msg('srv.s.toReview', { n });
  const fresh = rowOf(planId, sid);
  setState(planId, sid, { review, pending: [...fresh.pending.filter((p) => p.kind !== 'review'), { id: fid('review'), kind: 'review', files: review.files, ...(guard.length ? { guard } : {}), text, at: now() }] });
  emitTo('plan:' + planId, 'pending', { session: sid });
  addSessionMessage(planId, sid, 'system', `${text} : ${review.files.join(', ')}.`);
  pushNotice(planId, sid, 'review', review.files.join(','), guard.length ? { guard: true } : {});
};
// The merge found protected files the turns had not flagged (a commit after the last turn): the review opens « garde-fou touché »
const flagGuard = (planId, sid, touched) => {
  const row = rowOf(planId, sid); const prev = row.review;
  const guard = [...new Set([...(prev?.guard || []), ...touched])].sort();
  const review = { files: [...new Set([...(prev?.files || []), ...touched])].sort(), since: prev?.since || now(), seen: false, guard };
  const text = msg('srv.s.guardTouched', { files: guard.join(', ') });
  setState(planId, sid, { review, pending: [...row.pending.filter((p) => p.kind !== 'review'), { id: fid('review'), kind: 'review', files: review.files, guard, text, at: now() }] });
  emitTo('plan:' + planId, 'pending', { session: sid }); pushNotice(planId, sid, 'review', guard.join(','), { guard: true });
};
// Before any merge: the lines the branch adds may not carry a secret, the home folder, a phone or a LAN address. A trace
// refuses the merge and opens the review (file:line and kind, never the value, and the way out); an unreadable diff refuses.
// Two ways out: the trace removed from the branch (the next merge rescans, passes and closes what the net had opened),
// or, a false positive, « Relu » with the guardrail key on that very commit (review.privacyHead): a later commit asks again.
const privacyHold = async (planId, sid, plan, wt, rev) => {
  const head = rev || (await gitOut(wt.root, ['rev-parse', '--verify', wt.branch + '^{commit}']))?.trim();
  const refuse = (why) => { addSessionMessage(planId, sid, 'system', why); return { error: why }; };
  if (!head) return refuse('Vie privée : branche introuvable, fusion refusée : ' + wt.branch);
  const row = rowOf(planId, sid); const prev = row.review;
  if (prev?.seen && prev.privacyHead === head) return { head };
  let found; try { found = mergeprivacy.checkBranch({ root: wt.root, base: await baseOf(plan, wt), branch: head }); } catch (e) { return refuse('Vie privée : diff illisible, fusion refusée : ' + String(e.message).split('\n')[0]); }
  if (found.ok) {
    if (prev?.privacy && !prev.seen) { // the trace is gone: the net closes what it opened, the rest of the review stays
      const { privacy: _p, privacyFiles = [], ...rest } = prev; const files = rest.files.filter((f) => !privacyFiles.includes(f));
      const review = files.length || rest.guard?.length ? { ...rest, files } : { ...rest, files: prev.files, seen: true, seenAt: now(), closedBy: 'privacy-fixed' };
      setState(planId, sid, { review, pending: review.seen ? row.pending.filter((p) => p.kind !== 'review') : row.pending.map((p) => p.kind === 'review' ? { ...p, files, privacy: false } : p) });
      emitTo('plan:' + planId, 'pending', { session: sid });
    }
    return { head };
  }
  const why = mergeprivacy.reason(found.findings); const files = [...new Set(found.findings.map((f) => f.file))];
  const open = prev && !prev.seen ? prev.files : []; const privacyFiles = [...new Set([...(prev?.privacy && !prev.seen ? prev.privacyFiles || [] : []), ...files.filter((f) => !open.includes(f))])];
  const review = { ...(prev && !prev.seen ? prev : {}), files: [...new Set([...open, ...files])].sort(), since: (prev && !prev.seen && prev.since) || now(), seen: false, privacy: why, privacyFiles, ...(prev?.guardHead ? { guardHead: prev.guardHead } : {}), ...(prev?.guard ? { guard: prev.guard } : {}) };
  setState(planId, sid, { review, pending: [...row.pending.filter((p) => p.kind !== 'review'), { id: fid('review'), kind: 'review', files: review.files, ...(review.guard ? { guard: review.guard } : {}), privacy: true, text: why, at: now() }] });
  emitTo('plan:' + planId, 'pending', { session: sid }); addSessionMessage(planId, sid, 'system', why); pushNotice(planId, sid, 'review', 'privacy:' + files.join(','), {});
  return { error: why, privacy: found.findings };
};
const sessionDiff = async (planId, sid) => {
  const plan = planOf(planId); const wt = rowOf(planId, sid).worktree; if (!wt || !existsSync(wt.path)) throw new Error('la session n’a pas de worktree');
  const base = (await gitOut(wt.path, ['merge-base', await baseOf(plan, wt), 'HEAD']))?.trim() || await baseOf(plan, wt); const MAX = 200 * 1024; // three dots: from the merge base, like a PR
  const files = await changedFiles(plan, wt); const stat = ((await gitOut(wt.path, ['diff', '--stat', base])) || '').trim();
  let patch = (await gitOut(wt.path, ['diff', base])) || ''; const truncated = patch.length > MAX; if (truncated) patch = patch.slice(0, MAX) + '\n… (coupé à 200 Ko)';
  const review = rowOf(planId, sid).review;
  const head = (await gitOut(wt.root, ['rev-parse', '--verify', wt.branch + '^{commit}']))?.trim() || null;
  return { files, guarded: review?.files || [], guard: review?.guard || [], head, stat, patch, truncated };
};
// The human click on the Mac, never the engine: the session's guarded files are seen, the merge and the next waves are free
// A touched guardrail (review.guard) asks more: the key of the developer's browser (a session reaches 127.0.0.1 too), and the
// approval names the commit it saw (head, from the diff; else the branch's head now): a later commit asks again
const sessionReviewed = async (planId, sid, { key = null, head = null } = {}) => {
  const row = rowOf(planId, sid); if (row.worktree?.merged) throw mergedRefusal(row.worktree); if (!row.review) throw new Error('rien à relire');
  let guardHead = row.review.guardHead;
  if (guardrails.protectedTouched(row.review.guard || []).length || row.review.privacy) {
    if (!guardrails.keyMatches(key, GUARD_KEY)) { const e = new Error(msg('srv.s.guardKey', { file: path.join(guardrails.dirOf(), 'guard-link') })); e.status = 403; throw e; }
    const wt = row.worktree; const now_ = wt ? (await gitOut(wt.root, ['rev-parse', '--verify', wt.branch + '^{commit}']))?.trim() : null;
    if (!now_) throw new Error('branche introuvable');
    if (head && head !== now_) { const e = new Error(msg('srv.s.guardMoved')); e.status = 409; throw e; }
    guardHead = now_;
  }
  setState(planId, sid, { review: { ...row.review, seen: true, seenAt: now(), ...(guardHead ? { guardHead } : {}), ...(row.review.privacy && guardHead ? { privacyHead: guardHead } : {}) }, pending: row.pending.filter((p) => p.kind !== 'review') });
  addSessionMessage(planId, sid, 'system', `Relu : ${row.review.files.join(', ')}.`);
  const fresh = rowOf(planId, sid);
  if (fresh.status === 'done') await onDone(planId, sid); else { await checkWaves(planId); moveQueue(planId); }
  return { ok: true };
};

// ---------------------------------------------------------------- the merge on green tests, alone (phase 10, session A)
// The project's testCommand, else for Escadrille itself (the checkout this server runs from) its whole suite
const SELF_ROOT = (() => { try { return realpathSync(vars.SELF_ROOT || HERE); } catch { return path.resolve(vars.SELF_ROOT || HERE); } })();
const isSelf = (root) => { try { return !!root && realpathSync(root) === SELF_ROOT; } catch { return false; } };
const testCommandOf = (plan, a = autonomyOf(plan)) => a.testCommand || (isSelf(plan.project || plan.sessions?.[0]?.path) ? testbox.DEFAULT_SELF_TEST : null);
// The tests of the branch merged dry, in a verification worktree, boxed (lib/testbox.mjs): green merges; red tells the
// session once (the failures, it resumes), then the developer; no box here: the click of « À faire » stays
const verifying = new Set();
// The tests the project's environment setting declares for the repository of a session's worktree (docs/devenv.md), with
// the layout lib/testbox.mjs needs (the reads of the main checkout linked in), or null
const declaredTestsOf = (plan, row) => {
  const project = plan?.project; const root = row?.worktree?.root; if (!project || !root) return null;
  const entry = devenv.testsFor(environmentOf(project), project, root); if (!entry) return null;
  return { key: entry.key, ...devenv.testLayout({ project, root, entry }) };
};
// layout: the declared tests' links and siblings (declaredTestsOf), else none; merge: false runs the tests and tells the
// session and the card, the merge staying the developer's click (or the release of a kit)
const autoTests = async (planId, sid, cmd, { layout = null, merge = true } = {}) => {
  const key = keyOf(planId, sid); if (verifying.has(key)) return; verifying.add(key);
  try {
    const wt = rowOf(planId, sid).worktree; const head = await git(wt.root, ['rev-parse', wt.branch]);
    addSessionMessage(planId, sid, 'system', msg('srv.s.verifyStart', { cmd }) + (layout ? ` (tests déclarés pour ${layout.key}${layout.missing?.length ? ` ; introuvable : ${layout.missing.join(', ')}` : ''})` : ''));
    const r = await testbox.verifyMerge({ root: wt.root, branch: wt.branch, cmd, timeoutMs: TEST_TIMEOUT_MS, links: layout?.links || [], siblings: layout?.siblings || [] });
    if (r.boxError) { addSessionMessage(planId, sid, 'system', msg('srv.s.noBox', { why: r.boxError })); if (merge) askTests(planId, sid, cmd); return; }
    if (r.conflict) { if (!merge) { addSessionMessage(planId, sid, 'system', msg('srv.s.verifyFailed', { e: 'conflit avec ' + r.files.join(', ') })); return; } const m = await mergeSession(planId, sid); if (m?.conflict) await tellConflict(planId, sid, m.files); return; }
    const end = r.out.trim().split('\n').slice(-20).join('\n');
    addSessionMessage(planId, sid, 'system', `${msg('srv.s.verifyCode', { code: r.code })}${r.killed ? ' (10 min)' : ''}\n${end.slice(-4000)}`);
    if (r.flaky.length) addSessionMessage(planId, sid, 'system', msg('srv.s.flakyGreen', { files: r.flaky.join(', ') }));
    const fresh = rowOf(planId, sid);
    // The branch moved while its tests ran (a new turn): its next done is tested again
    if (fresh.status !== 'done' || fresh.worktree?.merged || (await git(wt.root, ['rev-parse', wt.branch])) !== head) return;
    setState(planId, sid, { worktree: { ...fresh.worktree, tests: { cmd, code: r.code, at: now(), failed: r.failed || [], flaky: r.flaky || [], head } } }); // the card shows it
    if (r.code === 0) { if (!merge) return; const m = await mergeSession(planId, sid); if (m?.conflict) await tellConflict(planId, sid, m.files); return; }
    await tellRed(planId, sid, cmd, r);
  } finally { verifying.delete(key); await checkWaves(planId); moveQueue(planId); }
};
// Red: the session is told once, with the failures, and resumes; a second red goes to the developer
const tellRed = async (planId, sid, cmd, r) => {
  const row = rowOf(planId, sid); const wt = row.worktree; const told = Number(wt.redTold) || 0;
  const summary = testbox.failureSummary(r.firstOut || r.out);
  if (told >= 1) {
    setPending(planId, sid, [...row.pending, { id: fid('alert'), kind: 'alert', what: 'tests', text: msg('srv.s.testsRedTwice', { code: r.code, files: (r.failed || []).join(', ') || cmd }), at: now() }]);
    pushNotice(planId, sid, 'waiting', 'tests-red:' + told, {}); return;
  }
  setState(planId, sid, { worktree: { ...wt, redTold: told + 1 } });
  const plan = planOf(planId); const s = plan.sessions.find((x) => x.id === sid);
  let proc = procOf(planId, sid); if (!proc || proc.exited) { stopProcess(planId, sid); proc = startProcess(plan, s, rowOf(planId, sid)); }
  const text = `Les tests de ta branche fusionnée à blanc dans main sont rouges (\`${cmd}\`, code ${r.code}${r.failed?.length ? ', ' + r.failed.join(', ') : ''}). Corrige, relance la suite verte dans ton worktree, commite, puis redis-toi finie.\n\n${summary}`;
  addSessionMessage(planId, sid, 'system', text);
  setState(planId, sid, { status: 'running', mode: 'page', pending: rowOf(planId, sid).pending.filter((p) => p.kind !== 'reply') });
  proc.send(text);
};
// A merge into Escadrille's own checkout that touched server.mjs, lib/ or run.sh: its code changed under it
const SELF_CODE = /^(server\.mjs|run\.sh|lib\/)/;
const selfFilesTouched = async (root, before, after) => (isSelf(root) && before && after && before !== after ? (await git(root, ['diff', '--name-only', before, after])).split('\n').filter((f) => SELF_CODE.test(f)) : []);
// The restart: under ./run.sh (ESCADRILLE_SUPERVISED=1) the server waits for its merges, tests and busy turns
// (ESCADRILLE_RESTART_WAIT_MS at most, 2 min), then exits with RESTART_CODE and run.sh starts it again; the sessions
// come back by « Reprise seule après redémarrage ». Not supervised: an entry asks the developer to restart it.
const RESTART_CODE = 75;
const RESTART_WAIT_MS = num(vars.RESTART_WAIT_MS, 120000);
let restarting = false;
const scheduleRestart = (planId, sid, files) => {
  console.log(`restart: a merge touched ${files.join(', ')}`);
  if (vars.SUPERVISED !== '1') { const row = rowOf(planId, sid); setPending(planId, sid, [...row.pending, { id: fid('info'), kind: 'info', text: msg('srv.s.restartByHand', { files: files.slice(0, 5).join(', ') }), at: now() }]); return; }
  if (restarting) return; restarting = true;
  addSessionMessage(planId, sid, 'system', msg('srv.s.restarting', { files: files.slice(0, 5).join(', ') }));
  const t0 = Date.now();
  const tick = setInterval(() => {
    const busy = verifying.size > 0 || [...live.values()].some((L) => L.proc && !L.proc.exited && L.proc.busy);
    if (busy && Date.now() - t0 < RESTART_WAIT_MS) return;
    clearInterval(tick); shutdown(RESTART_CODE);
  }, 200);
};

// The click: testCommand in the session's worktree (sh -c, 10 minutes at most) when no box can hold it; code 0 merges
// The tests run outside the sandbox on the session's code: an entry in « À faire », the developer's click runs them
const askTests = (planId, sid, cmd) => {
  const row = rowOf(planId, sid); if (row.pending.some((p) => p.kind === 'run-tests')) return;
  setPending(planId, sid, [...row.pending, { id: fid('run-tests'), kind: 'run-tests', cmd, text: msg('srv.s.runTests', { cmd }), at: now() }]);
  pushNotice(planId, sid, 'waiting', 'run-tests', {});
};
const runTests = async (planId, sid) => {
  refuseRetired(planId);
  const row = rowOf(planId, sid); const entry = row.pending.find((p) => p.kind === 'run-tests'); if (!entry) throw new Error('aucun test à lancer');
  setPending(planId, sid, row.pending.filter((p) => p.kind !== 'run-tests'));
  const r = await mergeIfGreen(planId, sid, entry.cmd); if (r?.conflict) await tellConflict(planId, sid, r.files); await checkWaves(planId); moveQueue(planId); return { ok: !!r?.ok, code: r?.code ?? 0 };
};
const TEST_TIMEOUT_MS = num(vars.TEST_TIMEOUT_MS, 600000);
const mergeIfGreen = async (planId, sid, cmd) => {
  const wt = rowOf(planId, sid).worktree; addSessionMessage(planId, sid, 'system', `Tests avant fusion : ${cmd}`);
  const r = await new Promise((resolve) => execFile('sh', ['-c', cmd], { cwd: wt.cwd || wt.path, timeout: TEST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${out || ''}${errOut || ''}`, killed: !!err?.killed })));
  const end = r.out.trim().split('\n').slice(-20).join('\n');
  addSessionMessage(planId, sid, 'system', `Tests : code ${r.code}${r.killed ? ' (10 min dépassées)' : ''}\n${end.slice(-4000)}`);
  if (r.code === 0) return mergeSession(planId, sid);
  const fresh = rowOf(planId, sid);
  setPending(planId, sid, [...fresh.pending, { id: fid('info'), kind: 'info', text: msg('srv.s.testsRed', { code: r.code, tail: tail(end, 160) }), at: now() }]);
  return { ok: false, code: r.code };
};

// The guards of canStart (lib/queue.mjs): a session to review, the plan's cap, the ask above X $, the weekly quota
const depsOf = (plan, s) => (s.after?.length ? s.after : plan.sessions.filter((x) => x.wave === (s.wave || 1) - 1).map((x) => x.id));
const reviewGuard = (plan, s) => {
  const waiting = depsOf(plan, s).map((d) => rowOf(plan.id, d)).filter((r) => r?.review && !r.review.seen && !r.worktree?.merged);
  return waiting.length ? { ok: false, why: msg('srv.s.reviewFirst', { list: waiting.map((r) => r.id).join(', ') }) } : null;
};
const capGuard = (plan) => { const cap = autonomyOf(plan).planCapUsd; return cap !== null && planCost(plan.id) >= cap ? { ok: false, why: `Plafond du plan atteint (${usd(cap)})` } : null; };
const askBudgetGuard = (plan, s) => {
  const a = autonomyOf(plan); if (a.mode === 'surveille' || a.askAboveUsd === null || plan.askBudgetLifted) return null;
  const cost = planCost(plan.id); const budget = budgetOf(s); if (cost + budget <= a.askAboveUsd) return null;
  const row = rowOf(plan.id, s.id);
  if (row && !stateOf(plan.id).some((r) => r.pending.some((p) => p.kind === 'ask-budget'))) {
    const text = msg('srv.s.askBudget', { cost: usd(cost), more: usd(budget), limit: usd(a.askAboveUsd) });
    setTimeout(() => { const fresh = rowOf(plan.id, s.id); setPending(plan.id, s.id, [...fresh.pending, { id: fid('ask-budget'), kind: 'ask-budget', cost, budget, limit: a.askAboveUsd, text, at: now() }]); pushNotice(plan.id, s.id, 'ask-budget', 'ask', {}); }, 0);
  }
  return { ok: false, why: msg('srv.s.aboveAsk', { limit: usd(a.askAboveUsd) }) };
};
const continueBudget = (planId, sid) => {
  refuseRetired(planId);
  const plan = planOf(planId); const next = { ...plan, askBudgetLifted: true };
  writeFileSync(path.join(PLANS_DIR, plan.id + '.json'), JSON.stringify(next, null, 1)); upsertPlan(next);
  for (const r of stateOf(planId)) if (r.pending.some((p) => p.kind === 'ask-budget')) setPending(planId, r.id, r.pending.filter((p) => p.kind !== 'ask-budget'));
  addSessionMessage(planId, sid, 'system', msg('srv.s.lifted'));
  checkWaves(planId).catch(() => {}); moveQueue(planId);
  return { ok: true };
};
const lastQuota = () => db.prepare('select weekly, reset_at from escadrilles where weekly is not null order by at desc limit 1').get() || null;
const quotaGuard = (plan) => { if (!autonomyOf(plan).stopAtQuotaLimit) return null; const q = lastQuota(); const why = q && autonomy.quotaRefusal(q.weekly, q.reset_at); return why ? { ok: false, why } : null; };
// The plan's cap reached: every process of the plan stops, one 'alert' entry says so
const checkPlanCap = (planId) => {
  const plan = planOf(planId); const cap = autonomyOf(plan).planCapUsd; if (cap === null) return;
  const cost = planCost(planId); if (cost < cap) return;
  const rows = stateOf(planId); if (rows.some((r) => r.alerted.includes('plan-cap'))) return;
  for (const r of rows) if (procOf(planId, r.id)) { stopProcess(planId, r.id); setState(planId, r.id, { mode: null }); }
  const first = rows.find((x) => x.usage) || rows[0];
  setState(planId, first.id, { alerted: [...first.alerted, 'plan-cap'] });
  setPending(planId, first.id, [...rowOf(planId, first.id).pending, { id: fid('alert-plan'), kind: 'alert', what: 'budget', pct: cost / cap, text: msg('srv.s.planCap', { cost: usd(cost), cap: usd(cap) }), at: now() }]);
  for (const r of rows) cancelFallback(planId, r.id);
};


const sessionMessage = (planId, sid, text, data) => {
  refuseRetired(planId); // a message relaunches a turn
  const plan = planOf(planId); const s = plan.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid); if (!s || !row) throw new Error('session inconnue');
  text = String(text || '').trim(); if (!text) throw new Error('message vide');
  if (['todo', 'later'].includes(row.status)) throw new Error(msg('srv.e.notLaunched'));
  // PIL: a person answered the session (not a fallback, not the pilot): its stops kept for Dev are released
  if (!data?.auto && !data?.pilot && !data?.fallback) { const project = projectOfPlan(planId); const held = project ? pilotOf(project).held || [] : []; if (held.some((k) => k.startsWith(`${planId}/${sid}/`))) setPilot(project, { held: wake.releaseHeld(held, planId, sid) }); }
  if (row.mode === 'terminal') throw new Error('la session est dans un terminal : reprends-la dans la page d’abord');
  if (row.status === 'done' && row.worktree?.merged) throw new Error(msg('srv.e.doneMerged'));
  addSessionMessage(planId, sid, 'dev', text, data);
  if (!data?.triage) ruleStreak.delete(keyOf(planId, sid)); // Phase 13 PIL: a person or the pilot wrote, the triage's rules may run again
  cancelFallback(planId, sid);
  const proc = procOf(planId, sid) || startProcess(plan, s, row);
  setState(planId, sid, { status: 'running', mode: 'page', pending: rowOf(planId, sid).pending.filter((p) => p.kind !== 'reply') });
  const body = takeCaptureNotes(planId, sid) + text; // Phase 8 B: the captures' lines lead the message
  // Phase 14 RAF: a message written during a turn waits, in the base (inboxOf); every one waiting leaves in one turn when it ends
  if (proc.busy) { const held = inboxPush(planId, sid, body); addSessionMessage(planId, sid, 'system', `En attente de la fin du tour : ${held} message${held > 1 ? 's partiront' : ' partira'} ensemble. « Envoyer maintenant » coupe le tour.`, { held }); return { ok: true, held }; }
  proc.send(body);
  return { ok: true };
};
// Phase 16 PAIR (docs/review.md « Le résumé de fin et le fil »): the end report, its captures, and the thread that relaunches
const httpError = (status, text) => Object.assign(new Error(text), { status });
const doneRoot = (row) => { const w = row?.worktree; const root = w && !w.merged ? (w.path || w.cwd) : null; return root && existsSync(root) ? root : null; };
const reviewDone = (planId, sid) => {
  const plan = planOf(planId); const s = plan?.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid); if (!s || !row) throw httpError(404, 'session inconnue');
  const done = donethread.doneOf(db, planId, sid); const root = doneRoot(row); const board = root ? donethread.latestBoard(root) : null;
  const link = (rel) => ({ path: rel, url: root && donethread.resolveCapture(root, rel) ? donethread.fileUrl(planId, sid, rel) : null });
  return { plan: planId, session: sid, title: `${s.id} · ${s.name}`, status: row.status, done, captures: (done?.captures || []).map(link), board: board ? link(board) : null, thread: donethread.threadOf(db, planId, sid) };
};
const guardRefused = () => httpError(403, msg('srv.s.guardKey', { file: path.join(guardrails.dirOf(), 'guard-link') }));
const reviewThreadPost = (b, { key }) => {
  const planId = String(b.plan || ''); const sid = String(b.session || ''); const row = rowOf(planId, sid); if (!row) throw httpError(404, 'session inconnue');
  const gab = guardrails.keyMatches(key, GUARD_KEY);
  if (b.type === 'review-comment') { // the GitHub connector's message (docs/connectors.md), with the developer's cookie; never relaunches
    if (!gab) throw guardRefused();
    const e = donethread.githubEntry(b); if (!e) throw httpError(400, 'commentaire vide');
    const entry = donethread.addEntry(db, planId, sid, e); notify('plan:' + planId); return { ok: true, entry, sent: false };
  }
  const source = b.source === 'qa' ? 'qa' : 'dev';
  if (source === 'dev' && !gab) throw guardRefused();
  if (!String(b.text ?? '').trim()) throw httpError(400, 'message vide');
  if (row.status === 'done' && row.worktree?.merged) throw httpError(400, 'Session fusionnée : ouvre une nouvelle session');
  const entry = donethread.addEntry(db, planId, sid, { source, body: b.text, author: source === 'qa' ? b.author || 'qa' : 'Dev' }); // written first: never lost
  const reopen = row.status === 'done';
  if (reopen && !(source === 'dev' && b.reopen === true)) { notify('plan:' + planId); return { ok: true, entry, sent: false }; } // waits for Dev's click
  if (reopen) { setState(planId, sid, { status: 'waiting' }); addSessionMessage(planId, sid, 'system', 'Rouverte par le fil de la Revue.'); }
  const r = sessionMessage(planId, sid, donethread.relayText(entry), { thread: entry.id });
  return { ok: true, entry: donethread.markSent(db, entry.id, { held: !!r.held }), sent: true, ...(r.held ? { held: r.held } : {}), ...(reopen ? { reopened: true } : {}) };
};
// The GitHub connector hands its review-comment messages here: the session found by plan and session, else by its branch or its PR
export const threadGithub = (m) => {
  const e = donethread.githubEntry(m); if (!e) return null;
  const rows = db.prepare('select plan, id from sessions').all().map((r) => rowOf(r.plan, r.id));
  const head = m.head || m.branch;
  const row = rows.find((r) => m.plan && r.plan === m.plan && r.id === m.session) || rows.find((r) => head && r.worktree?.branch === head) || rows.find((r) => m.pr && r.pr?.number === Number(m.pr));
  if (!row) return null; const entry = donethread.addEntry(db, row.plan, row.id, e); notify('plan:' + row.plan); return entry;
};
// Phase 14 RAF, « Envoyer maintenant »: the running turn is cut, what waits leaves at once in one turn
const sessionNow = (planId, sid) => {
  refuseRetired(planId);
  const proc = procOf(planId, sid); if (!proc) throw new Error('le processus de la session ne tourne plus');
  const held = inboxOf(planId, sid).length;
  const cut = proc.interrupt(); if (cut) addSessionMessage(planId, sid, 'system', `Tour coupé : ${held} message${held > 1 ? 's partent' : ' part'} maintenant.`);
  return { ok: true, cut, held };
};
const sessionAnswer = (planId, sid, b) => {
  const row = rowOf(planId, sid); if (!row) throw new Error('session inconnue');
  const ask = row.pending.find((p) => p.kind === 'permission' && p.id === b.id); if (!ask) throw new Error('demande inconnue');
  const proc = procOf(planId, sid); if (!proc) throw new Error('le processus de la session ne tourne plus');
  proc.answer(ask.id, { allow: !!b.allow, always: !!b.always, message: b.message });
  const auto = b.auto === true;
  addSessionMessage(planId, sid, 'system', ((w) => msg('srv.s.answered', { what: auto ? msg('srv.s.alone', { what: w, mode: autonomy.MODE_NAMES[autonomyOf(planOf(planId)).mode], reason: b.reason || msg('srv.s.localRule') }) : w, text: ask.text }))(msg(b.allow ? (b.always ? 'srv.s.allowedAlways' : 'srv.s.allowed') : 'srv.s.refused')), { answer: ask.id, allow: !!b.allow, ...(auto ? { auto: true, reason: b.reason || null } : {}) });
  setPending(planId, sid, row.pending.filter((p) => p.id !== ask.id));
  return { ok: true };
};
// Retire a plan (Dev, 6 November; docs/flot.md, « Retirer un plan »): its live sessions stop (our processes only, as
// sessionStop), its queue empties, its fallbacks are cancelled, the plan's JSON takes status 'closed' in the base and
// in plans/<id>.json, and every starting point refuses it (refuseRetired). Idempotent: twice gives the same plan.
const refuseRetired = (planId) => { if (isRetired(planOf(planId))) throw retiredError(); };
const writePlan = (next) => { writeFileSync(path.join(PLANS_DIR, next.id + '.json'), JSON.stringify(next, null, 1)); upsertPlan(next); };
const retirePlan = (planId, why) => {
  const plan = planOf(planId); if (!plan) throw Object.assign(new Error('unknown plan'), { status: 404 });
  const already = isRetired(plan);
  if (!already || (why && !plan.closedWhy)) writePlan(retiredPlan(plan, why, now()));
  const stopped = [];
  for (const r of stateOf(planId)) {
    cancelFallback(planId, r.id);
    if (r.queued) setState(planId, r.id, { queued: false, claude: '' });
    if (procOf(planId, r.id) || r.mode === 'page' || r.status === 'paused') { try { sessionStop(planId, r.id); stopped.push(r.id); } catch {} }
  }
  if (!already) {
    reapSoon('abandon');
    const p = planOf(planId); const line = msg('srv.s.retired', { why: p.closedWhy ? ` (${p.closedWhy})` : '', n: stopped.length });
    for (const s of plan.sessions) if (rowOf(planId, s.id)) addSessionMessage(planId, s.id, 'system', line);
    const project = projectOfPlan(planId); if (project) notify('main:' + project);
  }
  notify('plan:' + planId); notify('plans'); moveQueue(planId);
  return { ok: true, stopped, plan: planId, closedAt: planOf(planId).closedAt };
};
const reopenPlan = (planId) => {
  const plan = planOf(planId); if (!plan) throw Object.assign(new Error('unknown plan'), { status: 404 });
  if (isRetired(plan)) {
    writePlan(reopenedPlan(plan, now()));
    for (const s of plan.sessions) if (rowOf(planId, s.id)) addSessionMessage(planId, s.id, 'system', msg('srv.s.reopened'));
    notify('plan:' + planId); notify('plans');
  }
  return { ok: true, plan: planId };
};
const sessionStop = (planId, sid) => { const row = rowOf(planId, sid); if (!row) throw new Error(msg('srv.e.unknownSession')); stopProcess(planId, sid); setState(planId, sid, { mode: null, ...(['running', 'paused'].includes(row.status) ? { status: 'waiting' } : {}), pending: row.pending.filter((p) => p.kind !== 'permission') }); addSessionMessage(planId, sid, 'system', 'Processus arrêté.'); return { ok: true }; };
const sessionResume = (planId, sid) => {
  refuseRetired(planId);
  const plan = planOf(planId); const s = plan.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid); if (!s || !row) throw new Error('session inconnue');
  if (!row.sessionId) throw new Error(msg('srv.e.notStarted'));
  if (!procOf(planId, sid)) startProcess(plan, s, row);
  setState(planId, sid, { mode: 'page', ...(row.status === 'running' && !procOf(planId, sid)?.busy ? { status: 'waiting' } : {}) }); // busy: the inbox just left
  addSessionMessage(planId, sid, 'system', 'Reprise dans la page.');
  return { ok: true };
};
// The cap raised (docs/sessions.md, « Le reste du plafond »): the plan's JSON takes the new cap; a capped session
// (no process and its cost at the old cap, or its turn cut by Claude Code's --max-budget-usd) restarts with the rest
const usdN = (n) => String(n).replace('.', ',') + ' $';
const sessionBudget = (planId, sid, value) => {
  refuseRetired(planId);
  const plan = planOf(planId); const s = plan?.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid); if (!s || !row) throw new Error('session inconnue');
  const n = Number(value); if (value === null || typeof value === 'boolean' || value === '' || !Number.isFinite(n) || n <= 0) throw new Error('budget : un nombre de dollars > 0');
  const old = budgetOf(s);
  const next = { ...plan, sessions: plan.sessions.map((x) => (x.id === sid ? { ...x, budget: n } : x)) };
  writeFileSync(path.join(PLANS_DIR, plan.id + '.json'), JSON.stringify(next, null, 1)); upsertPlan(next);
  const rest = remaining(n, row.usage?.cost);
  // Phase 13 PIL: a live process keeps its --max-budget-usd of origin (2 November: X was cut at 14 $ with a 19 $ cap). Idle
  // between two turns, it is stopped and started again by --resume with the new cap; in the middle of a turn, at its end.
  const alive = procOf(planId, sid);
  if (alive && row.mode === 'page' && n > old) {
    if (row.status === 'waiting') {
      stopProcess(planId, sid); startProcess(planOf(planId), next.sessions.find((x) => x.id === sid), rowOf(planId, sid));
      addSessionMessage(planId, sid, 'system', msg('srv.s.rebudgetedNow', { n: usdN(n), rest: usd(rest) })); notify('plan:' + planId); return { ok: true, budget: n, remaining: rest, restarted: true };
    }
    if (row.status === 'running') { const L = live.get(keyOf(planId, sid)); if (L) L.rebudget = true; addSessionMessage(planId, sid, 'system', msg('srv.s.rebudgetedLater', { n: usdN(n) })); notify('plan:' + planId); return { ok: true, budget: n, remaining: rest, restarted: false, deferred: true }; }
  }
  const cutByClaude = row.health === 'error' && /budget/i.test(row.why || '');
  const capped = !procOf(planId, sid) && row.sessionId && row.mode !== 'terminal' && ['waiting', 'running'].includes(row.status) && ((row.usage?.cost ?? 0) >= old || cutByClaude);
  if (!capped) { addSessionMessage(planId, sid, 'system', msg('srv.s.raisedLater', { n: usdN(n), rest: usd(rest) })); notify('plan:' + planId); return { ok: true, budget: n, remaining: rest, restarted: false }; }
  const proc = startProcess(planOf(planId), next.sessions.find((x) => x.id === sid), row);
  setState(planId, sid, { status: 'running', mode: 'page', ...(cutByClaude ? { health: 'ok', why: '' } : {}), pending: row.pending.filter((p) => p.kind !== 'reply') });
  addSessionMessage(planId, sid, 'system', msg('srv.s.raised', { n: usdN(n), rest: usd(rest) }));
  proc.send(`Ton plafond passe à ${usdN(n)} ; continue.`);
  return { ok: true, budget: n, remaining: rest, restarted: true };
};
const sessionTerminal = async (planId, sid) => {
  const plan = planOf(planId); const s = plan.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid); if (!s || !row) throw new Error('session inconnue');
  if (!row.sessionId) throw new Error(msg('srv.e.notStarted'));
  const cwd = row.worktree?.cwd || s.path;
  stopProcess(planId, sid);
  const model = s.model && /^[\w.-]+$/.test(s.model) ? ` --model ${s.model}` : '';
  await openTerminal(cwd, `claude${model} --resume ${row.sessionId.replace(/[^\w-]/g, '')}`);
  setState(planId, sid, { mode: 'terminal', ...(row.status === 'running' ? { status: 'waiting' } : {}), pending: row.pending.filter((p) => p.kind !== 'permission'), claude: msg('srv.s.terminal', { app: TERMINAL, cwd }) });
  addSessionMessage(planId, sid, 'system', `Ouverte dans un terminal ${TERMINAL} (${cwd}).`);
  return { ok: true };
};

// Opens a terminal window in a folder and runs a command there. Nothing from the request reaches the
// shell: the folder comes from the worktree record, the command is built here.
const openTerminal = (cwd, cmd) => new Promise((resolve, reject) => {
  if (!PICKED_TERMINAL.name) return reject(new Error(PICKED_TERMINAL.error));
  const { file, args, detach } = PICKED_TERMINAL.argv(cwd, cmd);
  const fail = (msg) => reject(new Error(`terminal ${TERMINAL} : ${msg}`));
  // A Linux terminal window lives as long as it is open: detached, the call returns once it has started
  if (detach) {
    const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore' });
    child.once('error', (err) => fail(err.code === 'ENOENT' ? `${file} introuvable` : err.message));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, terminal: TERMINAL }); });
    return;
  }
  execFile(file, args, (err, out, errOut) => (err ? fail(String(errOut || err.message).trim()) : resolve({ ok: true, terminal: TERMINAL })));
});
// A request from this Mac: the loopback, or one of its own interface addresses (the page may be opened on the LAN name).
// The tests, and only them (ESCADRILLE_TEST_REMOTE=1), make a request count as remote with `x-escadrille-remote: 1`.
const ownAddresses = () => new Set(Object.values(networkInterfaces()).flat().map((i) => i.address));
const isLoopback = (req) => { if (TEST_REMOTE && req.headers['x-escadrille-remote'] === '1') return false; const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, ''); return a === '127.0.0.1' || a === '::1' || ownAddresses().has(a); };
// What the phone may call with its token (docs/phone.md): everything else is the Mac's, 403 from the LAN
const PHONE_ROUTES = (seg, method) => {
  if (seg[0] !== 'api') return false;
  if (method === 'GET') return (seg[1] === 'phone' && !seg[2]) || (seg[1] === 'game' && !seg[2]) || (seg[1] === 'plans' && !seg[2]) || seg[1] === 'events' || (seg[1] === 'plan' && !!seg[2] && (!seg[3] || (seg[3] === 'session' && seg[5] === 'messages' && !seg[6])));
  if (method === 'POST') return (seg[1] === 'phone' && ['push-token', 'forget'].includes(seg[2]) && !seg[3]) || (seg[1] === 'plan' && seg[3] === 'session' && ['answer', 'message', 'dismiss'].includes(seg[5]) && !seg[6]);
  return false;
};
const bearerOf = (req, url) => { const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || ''); return m ? m[1] : (url.pathname === '/api/events' ? url.searchParams.get('token') : null); };

// ---------------------------------------------------------------- la garde du Mac (docs/sessions.md): what runs, open, the dev server
let psWarned = false;
const runningNow = async () => {
  const sessions = [...live.entries()].filter(([, L]) => !L.proc.exited).map(([k, L]) => { const i = k.indexOf('/'); return { plan: k.slice(0, i), session: k.slice(i + 1), pid: L.proc.pid, cwd: L.cwd, since: L.since }; });
  const rows = db.prepare('select plan, id, worktree from sessions where worktree is not null').all().map((r) => ({ plan: r.plan, id: r.id, worktree: parse(r.worktree) }));
  const devservers = running.devServers();
  const mine = new Set([process.pid, ...sessions.map((s) => s.pid), ...devservers.map((d) => d.pid), ...[...planners.values()].map((p) => p.pid)].filter(Boolean));
  let others = [];
  try { others = await running.others({ exclude: mine, parents: mine }); } catch (e) { if (!psWarned) console.log(`running: ps refused (${e.message.split('\n')[0]}): no other claude listed`); psWarned = true; }
  const devenvs = running.devEnvs();
  const ours = running.ours({ sessions, rows, devservers, devenvs }).map((o) => ({ ...o, project: o.kind === 'devenv' ? devenvs.find((d) => d.plan === o.plan && d.session === o.session)?.project ?? projectOfPlan(o.plan) : projectOfPlan(o.plan) }))
    .map((o) => { if (o.kind !== 'devenv') return o; let h = []; try { h = environmentOf(o.project)?.health || []; } catch {} return { ...o, urls: h.length ? h : o.url ? [o.url] : [] }; });
  // the dev apps listening on the Mac (Docker of a project, an npm run dev started by hand, a capture instance), named by
  // the project whose environment.health has their port; ours (devserver, devenv) are left to their own row
  const taken = new Set(ours.flatMap((o) => [o.url, ...(o.urls || [])]).filter(Boolean).map((u) => { try { return new URL(u).port; } catch { return ''; } }));
  const healthPorts = new Map(); for (const pr of new Set(ours.map((o) => o.project).concat((() => { try { return registry.list(PROJECTS_FILE).map((x) => x.path); } catch { return []; } })())).values()) { if (!pr) continue; let h = []; try { h = environmentOf(pr)?.health || []; } catch {} for (const u of h) { try { const x = new URL(u); if (/^(localhost|127\.0\.0\.1)$/.test(x.hostname)) healthPorts.set(x.port, { project: pr, url: x.href.replace(/\/$/, '') }); } catch {} } }
  // role (lib/testapps.mjs): 'test' inside a session's worktree, 'env' the project's own server (its health port, or its folder,
  // on the branch the project is on: dev or the feature branch, read each time), 'other' the rest of the Mac
  const roots = testRoots(); const tRows = testRows(); const rootOf = (cwd) => roots.find((r) => cwd && (cwd === r || cwd.startsWith(r + '/'))) || null;
  const branches = new Map(); const branchOf = async (p) => { if (!p) return null; if (!branches.has(p)) branches.set(p, worktree.currentBranch(p).catch(() => null)); return branches.get(p); };
  const servers = await Promise.all((await vitalsLib.listeners()).filter((s) => !taken.has(String(s.port))).map(async (s) => {
    const h = healthPorts.get(String(s.port)); const x = h ? { ...s, project: h.project, url: h.url } : s;
    if (testapps.isTestCwd(s.cwd, roots)) { const o = testapps.ownerOf(s.cwd, tRows); return { ...x, role: 'test', plan: o?.plan ?? null, session: o?.id ?? null }; }
    const project = h?.project || rootOf(s.cwd); if (!project) return { ...x, role: 'other' };
    return { ...x, project, role: 'env', branch: await branchOf(project) };
  }));
  const vitals = await vitalsLib.vitals({ claude: sessions.length + planners.size + others.length });
  return { ours, others, servers, vitals };
};
const sessionOpen = (planId, sid) => {
  const plan = planOf(planId); const s = plan.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid); if (!s || !row) throw new Error('session inconnue');
  const folder = folderOf(s, row); if (!folder || !existsSync(folder)) throw new Error('le dossier de la session n’existe plus');
  return new Promise((resolve, reject) => execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [folder], (err, out, errOut) => (err ? reject(new Error('open : ' + String(errOut || err.message).trim())) : resolve({ ok: true }))));
};
// `npm run dev` in the session's folder: not Claude Code's sandbox (safeEnv keeps the secrets out, nothing keeps the network out)
const sessionDevServer = async (planId, sid) => {
  refuseRetired(planId);
  const plan = planOf(planId); const s = plan.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid); if (!s || !row) throw new Error('session inconnue');
  const cur = running.devServerOf(planId, sid); if (cur?.url) return { ok: true, url: cur.url };
  const folder = folderOf(s, row); if (!folder || !hasDev(folder)) throw new Error('pas de script dev dans ' + (folder ? path.join(folder, 'package.json') : 'le dossier'));
  const fresh = !cur;
  const changed = () => { notify('plan:' + planId); notify('running'); };
  const lines = []; const onLine = (l) => { lines.push(l.trim()); if (lines.length > 3) lines.shift(); };
  const { url, exited } = await running.startDevServer({ plan: planId, session: sid, cwd: folder, env: safeEnv(process.env), npm: NPM, timeoutMs: DEV_TIMEOUT_MS, onChange: changed, onLine });
  const last = lines.length ? ` Dernières lignes : ${lines.join(' / ').slice(0, 300)}` : '';
  if (fresh) addSessionMessage(planId, sid, 'system', url ? `Dev server lancé dans ${folder} : ${url}` : exited !== undefined ? `Le dev server s’est arrêté (code ${exited}) sans donner d’URL.${last}` : `Dev server lancé dans ${folder}, pas d’URL lue en ${Math.round(DEV_TIMEOUT_MS / 1000)} s.${last}`);
  return { ok: true, url };
};
// POST /api/running/stop { kind, plan, session }: only what this server started
const stopRunning = async ({ kind, plan: planId, session: sid, project } = {}) => {
  planId = String(planId || ''); sid = String(sid || '');
  if (kind === 'devenv') { const d = running.devEnvs().find((x) => (project && x.project === project) || (x.plan === planId && x.session === sid)); if (!d) throw new Error('aucun environnement démarré par calmdev'); return stopDevEnv(d.project); }
  const row = rowOf(planId, sid); if (!row) throw new Error('session inconnue');
  if (kind === 'session') { if (!procOf(planId, sid)) throw new Error('aucun processus claude pour cette session'); return sessionStop(planId, sid); }
  if (kind === 'devserver') { if (!(await running.stopDevServer(planId, sid))) throw new Error('aucun dev server pour cette session'); addSessionMessage(planId, sid, 'system', msg('srv.s.devStopped')); notify('plan:' + planId); notify('running'); return { ok: true }; }
  if (kind === 'worktree') {
    const wt = row.worktree; if (!wt || wt.merged || !existsSync(wt.path)) throw new Error('pas de worktree à retirer pour cette session');
    if (procOf(planId, sid)) throw new Error('la session tourne encore dans ce worktree : arrête-la d’abord');
    if (running.devServerOf(planId, sid)) throw new Error('son dev server tourne encore : arrête-le d’abord');
    const dirty = await git(wt.path, ['status', '--porcelain']);
    if (dirty) throw new Error(`le worktree a des changements non commités (${dirty.split('\n').length}) : rien n’est retiré`);
    await worktree.remove({ root: wt.root, path: wt.path });
    addSessionMessage(planId, sid, 'system', msg('srv.s.wtRemoved', { path: wt.path, branch: wt.branch })); reapSoon('abandon');
    notify('plan:' + planId); notify('running'); return { ok: true };
  }
  throw new Error('kind doit être session, devserver, worktree ou devenv');
};
// POST /api/running/stop-all: every claude process and dev server of this server (the worktrees stay: removing one is not stopping it)
const stopAllRunning = async () => {
  const stopped = [];
  for (const k of [...live.keys()]) { const i = k.indexOf('/'); const [planId, sid] = [k.slice(0, i), k.slice(i + 1)]; if (procOf(planId, sid)) { sessionStop(planId, sid); stopped.push({ kind: 'session', plan: planId, session: sid }); } }
  for (const d of running.devServers()) { await running.stopDevServer(d.plan, d.session); addSessionMessage(d.plan, d.session, 'system', msg('srv.s.devStopped')); notify('plan:' + d.plan); stopped.push({ kind: 'devserver', plan: d.plan, session: d.session }); }
  for (const d of running.devEnvs()) { try { await stopDevEnv(d.project); stopped.push({ kind: 'devenv', plan: d.plan, session: d.session, project: d.project }); } catch (e) { console.error('devenv down', e.message); } }
  vitalsLib.forgetListeners(); notify('running');
  return { ok: true, stopped };
};
// The test apps stop alone (lib/testapps.mjs, Dev 6 November): at a merge, an abandon, one hour after the session is done, and at
// the start for those no session owns. No setting, no button; one line in server.log per app stopped.
const testRoots = () => { const s = new Set(); try { for (const x of registry.list(PROJECTS_FILE)) if (x.path) s.add(x.path); } catch {} for (const r of db.prepare('select distinct project from plans where project is not null').all()) s.add(r.project); s.add(process.cwd()); return [...s]; };
const testRows = () => db.prepare('select plan, id, status, at, worktree from sessions').all().map((r) => ({ plan: r.plan, id: r.id, status: r.status, at: r.at, worktree: parse(r.worktree), retired: isRetired(planOf(r.plan)) }));
const reapTestApps = async (why = 'sweep') => {
  const rows = testRows(); const roots = testRoots(); let n = 0;
  for (const d of testapps.toStop({ apps: running.devServers(), rows, roots })) { await running.stopDevServer(d.plan, d.session); n++; console.log(`test apps: dev server ${d.plan}/${d.session} stopped (${d.why}, ${why})`); }
  vitalsLib.forgetListeners(); let listening = [];
  try { listening = await vitalsLib.listeners(); } catch {}
  for (const a of testapps.toStop({ apps: listening, rows, roots })) { try { process.kill(a.pid, 'SIGTERM'); n++; console.log(`test apps: pid ${a.pid} on :${a.port} in ${a.cwd} stopped (${a.why}, ${why})`); } catch (e) { console.log(`test apps: pid ${a.pid} not stopped (${e.code || e.message})`); } }
  if (n) { vitalsLib.forgetListeners(); notify('running'); }
  return n;
};
const reapSoon = (why) => { if (!TEST_APPS_SWEEP) return; setTimeout(() => reapTestApps(why).catch((e) => console.error('test apps', e.message)), 500).unref(); };
const TEST_APPS_SWEEP = vars.TEST_APPS_SWEEP !== 'off' && (!process.env.NODE_TEST_CONTEXT || vars.TEST_APPS_SWEEP === 'on'); // a test server never kills on the Mac
if (TEST_APPS_SWEEP) setInterval(() => reapSoon('sweep'), testapps.SWEEP_MS).unref();

// ---------------------------------------------------------------- the escadrilles and their planning sessions
const planners = new Map(); // escadrille id -> the running planner
const SKILL = (() => { try { return readFileSync(path.join(HERE, '.claude', 'skills', 'plan', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, ''); } catch { return ''; } })();
// The plan templates (plans/templates/<id>.json, shipped with the code): the chat offers them, the planner gets the chosen one's hints
const TEMPLATES = (() => { const dir = path.join(HERE, 'plans', 'templates'); try { return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'))); } catch { return []; } })();
const templateOf = (id) => TEMPLATES.find((t) => t.id === id) || null;
const templateSection = (id) => { const t = templateOf(id); return t ? `\n\n## Le gabarit choisi\n\n${t.title}\n${t.summary}\n\nConsignes du gabarit :\n${t.hints.map((h) => '- ' + h).join('\n')}` : ''; };
// ---------------------------------------------------------------- the resources of a project (docs/resources.md)
const CLAUDE_HOME = vars.HOME || homedir(); // the tests point it at a throwaway home
const CATALOG = path.join(HERE, 'catalog', 'capabilities.json');
const resourcesFor = (project) => resources.resourcesOf(project, { home: CLAUDE_HOME, addDirs: settingsOf(project).addDirs, secretsFile: vars.SECRETS });
// The planners' install proposals of the project, and what its sessions asked (or were refused) in the journal
const installsOf = (project) => db.prepare("select m.data from messages m join escadrilles e on e.id = m.escadrille where m.role = 'install' and e.project = ?").all(project).flatMap((r) => parse(r.data, {}).items || []);
const asksOf = (project) => db.prepare("select m.role, m.text, m.data from session_messages m join plans p on p.id = m.plan where p.project = ? and (m.role = 'ask' or (m.role = 'system' and m.text like 'Refus%')) order by m.seq desc limit 2000").all(project).map((r) => ({ text: `${r.text || ''} ${r.role === 'ask' ? r.data || '' : ''}`, refused: r.role === 'system' }));
const capabilitiesFor = (project) => ({ rule: 'Planificateur +3 · journal +3 · fichier +2 · langage +1 · sur le Mac +1', items: resources.capabilitiesOf(project, { home: CLAUDE_HOME, catalog: resources.loadCatalog(CATALOG), installs: installsOf(project), asks: asksOf(project) }) });
const resourcesRoute = async (req, res, url) => {
  const p = url.pathname; const m = req.method;
  if (p === '/api/resources' && m === 'GET') return json(res, 200, resourcesFor(projectArg(url.searchParams.get('project'))));
  if (p === '/api/resources/capabilities' && m === 'GET') return json(res, 200, capabilitiesFor(projectArg(url.searchParams.get('project'))));
  if (p === '/api/resources/skill' && m === 'GET') return json(res, 200, resources.readSkill(projectArg(url.searchParams.get('project')), url.searchParams.get('name'), { home: CLAUDE_HOME }));
  if (p === '/api/resources/file' && m === 'DELETE') return json(res, 200, resources.removeFile(projectArg(url.searchParams.get('project')), url.searchParams.get('path')));
  if (m !== 'POST') return json(res, 404, { error: 'route inconnue' });
  let b; try { b = await readBody(req, p === '/api/resources/file' ? 28e6 : 1e6); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'fichier : 20 Mo au plus' : 'JSON illisible' }); }
  const project = projectArg(b.project);
  if (p === '/api/resources/file') { try { return json(res, 200, resources.addFile(project, b)); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.message }); } }
  if (p === '/api/resources/note') return json(res, 200, resources.setNote(project, b));
  if (p === '/api/resources/skill') return json(res, 200, resources.switchSkill(project, b, { home: CLAUDE_HOME }));
  if (p === '/api/resources/plugin') return json(res, 200, resources.switchPlugin(project, b));
  return json(res, 404, { error: 'route inconnue' });
};
const resourcesPromptOf = (project) => { if (!project || !existsSync(project)) return ''; try { return resources.resourcesSection(resourcesFor(project)); } catch { return ''; } };
const systemPromptFor = (e) => `${SKILL}\n\n## Cette planification\n\nProjet : ${e.project}\nModèle choisi par le développeur : ${modelName(e.model)} (${e.model})\nDate : ${new Date().toISOString().slice(0, 10)}\nLe serveur calmdev tourne sur http://localhost:${PORT} ; tu n'as pas à l'appeler, il lit tes blocs.${memorySection(e.project)}${resourcesPromptOf(e.project)}${templateSection(e.template)}${burstSectionOf(e.id)}${limitsSectionOf(e.project)}${learningSectionOf(e.project)}`;

const escadrilleOf = (id) => { const r = db.prepare('select * from escadrilles where id = ?').get(id); if (!r) return null; return { ...r, install: r.install ? JSON.parse(r.install) : null, usage: r.usage ? JSON.parse(r.usage) : null }; };
const messagesOf = (id) => db.prepare('select * from messages where escadrille = ? order by seq').all(id).map((m) => ({ ...m, data: m.data ? JSON.parse(m.data) : null }));
const addMessage = (id, role, text, data) => { db.prepare('insert into messages (escadrille, role, text, data, at) values (?, ?, ?, ?, ?)').run(id, role, text ?? '', data ? JSON.stringify(data) : null, now()); };
const setEscadrille = (id, fields) => { const keys = Object.keys(fields); if (!keys.length) return; db.prepare(`update escadrilles set ${keys.map((k) => `${k} = ?`).join(', ')}, at = ? where id = ?`).run(...keys.map((k) => fields[k]), now(), id); };
const touch = (id) => notify('escadrille:' + id);

// The projects of Escadrille (phase 11 S, lib/projects.mjs): the registry, never every folder Claude Code knows.
// The default server reads ~/.config/escadrille/projects.json (install.sh writes there too); a server on another
// base (the tests, a branch seen on 31xx) keeps its own registry beside that base, so it never touches the developer's.
const PROJECTS_FILE = vars.PROJECTS || (vars.DB || process.env.SM_DB ? DB_FILE + '.projects.json' : registry.registryFile());
// Each known project's .escadrille/ (and its worktrees') moves to .calmdev/ once, .calmdev/ beside it in .gitignore
if (vars.MIGRATE !== 'off') {
  let known = []; try { known = registry.read(PROJECTS_FILE).projects.map((x) => x.path); } catch {}
  for (const r of names.migrateAll({ projects: known, config: false, log: (l) => console.log('names: ' + l) })) if (r.state === 'error') console.error('names: ' + r.what + ' not migrated (' + r.error + ')');
}
// Once per registry, at the first read: the projects that already have a plan or a conversation enter by themselves
let migrationChecked = false;
const migrateRegistry = () => {
  if (migrationChecked) return; migrationChecked = true;
  const paths = db.prepare("select project from plans where project is not null union select project from escadrilles where project is not null union select project from main_messages").all().map((r) => r.project);
  try { registry.migrate(paths, { file: PROJECTS_FILE }); } catch (e) { console.error('projects: migration not written (' + e.message + ')'); }
};
// The last activity here (a conversation, a plan, the main thread): the most recent project first
const lastActivity = (p) => db.prepare('select max(at) as at from (select max(at) as at from escadrilles where project = ? union all select max(created) from plans where project = ? union all select max(at) from main_messages where project = ?)').get(p, p, p).at || '';
const knownProjects = () => {
  migrateRegistry();
  const recent = new Set(db.prepare('select distinct project from escadrilles').all().map((r) => r.project));
  return registry.list(PROJECTS_FILE)
    .map((x) => ({ path: x.path, name: registry.displayName(x), recent: recent.has(x.path), via: x.via, added: x.added, last: lastActivity(x.path) }))
    .sort((a, b) => (b.last || b.added || '').localeCompare(a.last || a.added || ''));
};
const projectsAnswer = () => ({ claude: claudeStatus(), projects: knownProjects().map((p) => ({ ...p, escadrilles: db.prepare('select count(*) as n from escadrilles where project = ?').get(p.path).n, plans: db.prepare('select count(*) as n from plans where project = ?').get(p.path).n })), models: listModels().filter((m) => m.available).map(({ id, name }) => ({ id, name })) });

// What the planning session will find in a folder: the page shows it before the idea is sent
const git = (cwd, args) => new Promise((resolve) => execFile('git', args, { cwd, timeout: 4000 }, (err, out) => resolve(err ? '' : String(out).trim())));
// git's « 3 minutes ago », said in French (« il y a 3 min »)
const frAgo = (s) => { const m = /^(\d+) (second|minute|hour|day|week|month|year)s?\b/.exec(s); if (!m) return s; const n = Number(m[1]); const u = { second: 's', minute: 'min', hour: 'h', day: n > 1 ? 'jours' : 'jour', week: 'sem.', month: 'mois', year: n > 1 ? 'ans' : 'an' }[m[2]]; return `il y a ${n} ${u}`; };
const projectFacts = async (p) => {
  if (!p || !existsSync(p) || !statSync(p).isDirectory()) throw new Error('dossier introuvable');
  const has = (f) => existsSync(path.join(p, f));
  const isGit = (await git(p, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  const [branch, last, changed, count] = isGit ? await Promise.all([git(p, ['branch', '--show-current']), git(p, ['log', '-1', '--format=%s%n%cr']), git(p, ['status', '--porcelain']), git(p, ['rev-list', '--count', 'HEAD'])]) : ['', '', '', ''];
  const memDir = path.join(homedir(), '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  const memories = existsSync(memDir) ? readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length : 0;
  const skillsDir = path.join(p, '.claude', 'skills');
  const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((f) => existsSync(path.join(skillsDir, f, 'SKILL.md'))) : [];
  const docs = ['CLAUDE.md', 'README.md', 'ROADMAP.md', 'AGENTS.md', 'docs'].filter(has);
  const pkg = has('package.json') ? (() => { try { const j = JSON.parse(readFileSync(path.join(p, 'package.json'), 'utf8')); return { name: j.name, deps: Object.keys(j.dependencies || {}).length }; } catch { return null; } })() : null;
  return { path: p, name: path.basename(p), git: isGit, branch, lastCommit: last.split('\n')[0] || '', lastWhen: frAgo(last.split('\n')[1] || ''), commits: Number(count) || 0, changed: changed ? changed.split('\n').length : 0, docs, memories, skills, pkg, settings: has('.claude/settings.json') };
};

// What the planning session says lands in the messages; its plan and install blocks become the escadrille's
const onPlannerEvent = (id) => (ev) => {
  const e = escadrilleOf(id); if (!e) return;
  if (ev.type === 'init') { if (ev.sessionId && ev.sessionId !== e.session_id) setEscadrille(id, { session_id: ev.sessionId }); return; }
  if (ev.type === 'activity') { addMessage(id, 'activity', ev.text); touch(id); return; }
  if (ev.type === 'error') { addMessage(id, 'error', ev.text); setEscadrille(id, { status: 'error' }); touch(id); return; }
  if (ev.type === 'quota') { if (typeof ev.weekly === 'number') setEscadrille(id, { weekly: ev.weekly, reset_at: ev.resetsAt }); noteWindows(ev); return; }
  if (ev.type === 'turn') {
    const u = e.usage || { input: 0, output: 0, cost: 0, turns: 0 };
    const usage = { input: u.input + ev.usage.input, output: u.output + ev.usage.output, cost: ev.cost || u.cost, turns: u.turns + 1, lastInput: ev.usage.input, contextWindow: ev.contextWindow || u.contextWindow, model: ev.model };
    setEscadrille(id, { usage: JSON.stringify(usage), status: e.status === 'error' ? 'error' : 'waiting' });
    if (burstAnswer.delete(id)) burstAnswerQuestions(id); // a burst's planner: « ok pour tout », as « Tout accepter »
    touch(id); return;
  }
  if (ev.type === 'exit') { planners.delete(id); const cur = escadrilleOf(id); if (cur && cur.status === 'thinking') { setEscadrille(id, { status: 'error' }); addMessage(id, 'error', 'La session de planification s’est arrêtée avant de répondre.'); } touch(id); return; }
  if (ev.type !== 'text') return;
  const blocks = findBlocks(ev.text); const prose = stripBlocks(ev.text);
  if (prose) addMessage(id, 'claude', prose);
  for (const b of blocks) {
    if (b.error) { addMessage(id, 'error', `Bloc ${b.kind} illisible : ${b.error}`, { raw: b.raw }); continue; }
    if (b.kind === 'questions') { const { items, errors } = validateQuestions(b.value); if (errors) { addMessage(id, 'error', errors.join(' ; ')); continue; } addMessage(id, 'questions', `${items.length} question${items.length > 1 ? 's' : ''}`, { items }); if (burstTaskOfEsc(id)) burstAnswer.add(id); continue; }
    if (b.kind === 'install') { const { items, errors } = validateInstall(b.value); if (errors) { addMessage(id, 'error', errors.join(' ; ')); continue; } const prev = e.install || []; const merged = items.map((it) => ({ ...it, checked: prev.find((p) => p.name === it.name)?.checked ?? it.checked })); setEscadrille(id, { install: JSON.stringify(merged) }); addMessage(id, 'install', `${merged.length} proposition${merged.length > 1 ? 's' : ''}`, { items: merged }); continue; }
    if (b.kind === 'plan') {
      const prefix = new Date().toISOString().slice(0, 10);
      const { plan, errors } = validatePlan(withSettings({ ...b.value, id: e.plan_id || b.value.id }, e.project), { path: e.project, model: e.model, idPrefix: prefix, project: e.project });
      if (errors) { addMessage(id, 'error', 'Le plan a des manques : ' + errors.join(' ; '), { raw: b.raw }); continue; }
      plan.escadrille = id;
      const bt = burstTaskOfEsc(id); if (bt) Object.assign(plan, burstShape(bt, plan)); // a burst's plan: no network, autonome, caps within the rest
      const looser = autonomyRefusals(plan); if (looser.length) { addMessage(id, "error", "Autonomie plus souple que le projet, refusée : " + looser.join(" ; ")); continue; }
      const refused = planRefusals(plan); if (refused.length) { addMessage(id, 'error', 'Le plan est déjà lancé, nouvelle version refusée : ' + refused.join(' ; ')); continue; }
      writeFileSync(path.join(PLANS_DIR, plan.id + '.json'), JSON.stringify(plan, null, 1));
      upsertPlan(plan); setEscadrille(id, { plan_id: plan.id, title: plan.title });
      addMessage(id, 'plan', plan.title, { id: plan.id, sessions: plan.sessions.length, waves: plan.waves.length });
      notify('plan:' + plan.id);
      if (bt) burstPlanWritten(bt, plan.id);
    }
  }
  touch(id);
};

const plannerFor = (e) => {
  let p = planners.get(e.id);
  if (p && !p.exited) return p;
  p = startPlanner({ cwd: e.project, model: e.model, systemPrompt: systemPromptFor(e), resume: e.session_id || undefined, ...plannerNetwork(e.project), onEvent: onPlannerEvent(e.id) });
  planners.set(e.id, p);
  return p;
};
const createEscadrille = (b, opts = {}) => {
  const project = String(b.project || '').trim(); const idea = String(b.idea || '').trim();
  if (!project || !existsSync(project) || !statSync(project).isDirectory()) throw new Error('choisis un dossier de projet qui existe');
  guardSelfEdit(project);
  if (b.model && !isModel(String(b.model))) throw new Error(`modèle inconnu ${b.model}`);
  const model = plannerModel(b.model && String(b.model), settingsOf(project).model); // the escadrille's, else the project's (stored, else the last chosen), else the list's default
  if (!idea) throw new Error(msg('srv.e.idea'));
  const template = b.template ? String(b.template) : null;
  if (template && !templateOf(template)) throw new Error('gabarit inconnu : ' + template);
  const first = idea.split(/\n/)[0].replace(/\s+/g, ' ').trim();
  const title = first.length <= 64 ? first : first.slice(0, 64).replace(/\s+\S*$/, '').replace(/[\s:;,.(«-]+$/, '') + '…';
  const id = `${slug(title).split('-').slice(0, 4).join('-') || 'escadrille'}-${randomBytes(2).toString('hex')}`;
  db.prepare('insert into escadrilles (id, title, project, model, session_id, plan_id, status, install, usage, weekly, reset_at, created, at, template) values (?, ?, ?, ?, null, null, ?, null, null, null, null, ?, ?, ?)').run(id, title, project, model, 'thinking', now(), now(), template);
  if (opts.burst) burstOfEsc.set(id, opts.burst); // read by systemPromptFor before the planner starts
  addMessage(id, 'user', idea);
  plannerFor(escadrilleOf(id)).send(idea);
  return { id };
};
const sendMessage = (id, text) => {
  const e = escadrilleOf(id); if (!e) throw new Error('escadrille inconnue');
  text = String(text || '').trim(); if (!text) throw new Error('message vide');
  addMessage(id, 'user', text); setEscadrille(id, { status: 'thinking' });
  plannerFor(e).send(text); touch(id);
  return { ok: true };
};

// ---------------------------------------------------------------- Phase 8 A, the pilot of a project (docs/pilot.md, lib/pilot.mjs)
// One process per wake, resumed by --resume, read-only in the sandbox; only its own ```escadrille:pilot blocks act
const pilotRecord = (r) => { try { pilotlog.record(db, r); } catch (e) { console.error('pilotlog', e.message); } }; // session D's journal
const pilotProcs = new Map(); // project → { proc, prose: [], refs: [], proposal, refused: [], ended }
const pilotRefusals = new Map(); // project → lines told to the pilot at its next wake
const pilotOf = (project) => ({ on: false, sessionId: null, cursor: null, day: null, spent: 0, ...(storedSettings(project).pilot || {}) });
// A pilot is present when the built-in one is on, or an external one (a Claude Code conversation driving the API) declared
// itself with POST /api/pilot { project, external: true } within the last minutes (lib/todo.mjs). What it can handle is
// then never notified to the developer, and the Flot says « attend le pilote » (lib/projectflow.mjs).
const presence = todo.createPresence();
// PIL: while the watchdog hands the pilot's requests to Dev (pilotStall), the pilot counts as absent: « À toi » and the phone show them
const pilotStall = new Map(); // project → { reason, at }
const pilotForce = new Map(); // project → keys the watchdog found missed, carried by the next wake whatever seen says
const pilotLastWord = new Map(); // project → the date of the pilot's last event in a turn (the watchdog's « ne répond plus »)
const pilotPresent = (project) => !!project && !pilotStall.has(project) && presence.present(project, pilotOf(project).on);
// « À toi » (docs/asks.md): the permissions of this server that must open the modal, oldest first. Only its own: a
// Studio's are counted in `remote`, never answered from here (empty while no paired Studio is known, docs/asks.md).
const ASK_WRITES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const askGuard = (p, row) => { // a write to a protected guardrail of Escadrille itself (docs/autonomy.md)
  if (pilotMuted(row.plan, row.session, p)) return true; // PIL 6 November: what the pilot may not grant is the developer's
  if (!ASK_WRITES.includes(p.tool) || !row.root) return false;
  try { if (!guardrails.isEscadrille(row.root)) return false; } catch { return false; }
  const f = String(p.input?.file_path || p.input?.notebook_path || ''); const rel = row.cwd && f.startsWith(row.cwd + '/') ? f.slice(row.cwd.length + 1) : f;
  return guardrails.protectedTouched([rel]).length > 0;
};
const asksNow = (project = null) => {
  const rows = [];
  for (const { id } of plansList(project)) { const plan = planOf(id); if (!plan) continue;
    // An ask older than 12 h whose session has no process left can no longer be answered: it never opens the modal (Dev,
    // 3 November: a two-day-old ask of a dead session came back on every page). A recent one stays (a session restarting)
    // (6 Nov.) a stop waiting for a reply counts too, stale or not: answering it resumes the session
    for (let r of stateOf(id)) { const dead = !procOf(id, r.id); const stale = (p) => p.kind === 'permission' && dead && Date.now() - Date.parse(p.at) > 12 * 3600e3;
      r = { ...r, pending: (r.pending || []).filter((p) => !stale(p)) };
      if (!r.pending.some((p) => p.kind === 'permission' || p.kind === 'reply') && r.status !== 'waiting') continue;
      const s = (plan.sessions || []).find((x) => x.id === r.id) || {};
      rows.push({ plan: id, session: r.id, sessionName: s.name || r.name || r.id, project: plan.project || null, cwd: r.worktree?.cwd || r.worktree?.path || s.path || null, root: r.worktree?.root || plan.project || null, pending: r.pending, status: r.status, at: r.at || null, human: humanOf(r, s.stops || []) }); } }
  return { ...asks.listOf(rows, { pilotOn: (p) => pilotPresent(p), now: Date.now(), guard: askGuard }), remote: [] };
};
const setPilot = (project, fields) => { const st = storedSettings(project); st.pilot = { ...pilotOf(project), ...fields }; db.prepare('insert into project_settings (project, json, at) values (?, ?, ?) on conflict(project) do update set json = excluded.json, at = excluded.at').run(project, JSON.stringify(st), now()); notify('main:' + project); return st.pilot; };
const pilotCaps = (project) => { const st = storedSettings(project); return { budget: st.pilotBudget ?? pilot.DEFAULT_BUDGET, daily: st.pilotDaily ?? pilot.DEFAULT_DAILY }; };
const pilotSay = (project, role, text, data = null) => { const m = mainchat.addMessage(db, { project, role, text, source: role === 'claude' ? 'pilot:' + (pilotOf(project).sessionId || 'nouveau') : 'pilot', data }); notify('main:' + project); return m; };
// Phase 13 PIL: the view adds the policy, the handoff thresholds and the figures (wakes by outcome, wake costs before and after
// the first handoff, delegated messages) that docs/pilot.md reports
const pilotView = (project) => { const age = pilotwatch.oldestAge(pilotRequests(project)); const p = pilotOf(project); const c = pilotCaps(project); const st = storedSettings(project); return { on: !!p.on, sessionId: p.sessionId, busy: pilotWaker.busy(project), cursor: p.cursor, spentToday: pilot.spentToday(p), budget: c.budget, daily: c.daily, model: pilotModel(st.pilotModel), modelName: modelName(pilotModel(st.pilotModel)), wake24h: pilothandoff.recentAvg(p.costs || [], Date.now()), policy: pilotpolicy.policyOn(st), triage: st.pilotTriage !== false, handoff: { ...pilothandoff.thresholdsOf(st), count: p.handoffs || 0 }, delegateUsd: st.pilotDelegateUsd ?? msgtriage.DELEGATE_BUDGET, stats: { wakes: { ...(p.stats || {}), cheapShare: wake.cheapShare(p.stats) }, costs: pilothandoff.costStats(p.costs || []), messages: { ...(p.messages || {}), delegatedShare: msgtriage.delegatedShare(p.messages) } }, external: presence.external(project), externalUntil: presence.external(project) ? presence.until(project) : null, present: pilotPresent(project), oldestAgeMs: age, oldestLine: pilotwatch.ageLine(age), stall: pilotStall.get(project) || null, unanswered: pilotdeath.unanswered({ pending: mainchat.pendingOf(db, project).messages, stall: pilotStall.get(project) || null }) }; };
const pilotNotes = new Map(); // project → lines the pilot reads at its next wake (delegated questions, checks, handoffs)
const pilotNote = (project, line) => pilotNotes.set(project, [...(pilotNotes.get(project) || []), line].slice(-30));
const pilotDoing = new Map(); // project → { what, since } while a wake runs (what Dev reads when the pilot is busy)
const routing = new Set(); // the seqs of the developer's messages being triaged: not carried to a wake meanwhile
// A short model call outside the pilot (the triage, the routing, a delegated question): read-only in the sandbox, capped, one turn
const runSmall = ({ cwd, model, systemPrompt, budget, prompt, timeoutMs = 180000 }) => new Promise((resolve, reject) => {
  let text = ''; let done = false; let proc = null;
  const finish = (fn) => { if (done) return; done = true; clearTimeout(t); try { proc?.stop(); } catch {} fn(); };
  const t = setTimeout(() => finish(() => reject(new Error('délai dépassé'))), timeoutMs);
  try {
    proc = startPlanner({ cwd, model, systemPrompt, budget, onEvent: (ev) => {
      if (ev.type === 'text') text += ev.text + '\n';
      else if (ev.type === 'turn') finish(() => resolve({ text, cost: ev.cost || 0 }));
      else if (ev.type === 'error') finish(() => reject(new Error(tail(ev.text, 200))));
      else if (ev.type === 'exit') finish(() => (text ? resolve({ text, cost: 0 }) : reject(new Error('arrêt sans réponse'))));
    } });
    proc.send(prompt);
  } catch (e) { finish(() => reject(e)); }
});
// FIAB 2 (6 November): nextStep for a stored row, with its plan's stops and the project's cran (lib/nextstep.mjs)
const stepOf = (plan, row = {}) => { const s = plan?.sessions?.find((x) => x.id === row.id) || {}; const on = pilotPresent(plan?.project);
  return nextStep({ ...row, plan: plan?.id, stops: s.stops || [], delivery: plan?.delivery, autoMerge: plan?.autoMerge }, { id: plan?.project, pilotOn: on, pilotPresent: on, mode: (storedSettings(plan?.project).autonomy || {}).mode }); };
// The session branches git has in main (`git branch --merged main`), per project, read once per wake
const pilotMerged = new Map();
const refreshMerged = (project) => { if (!project || !existsSync(project)) return;
  gitOut(project, ['branch', '--merged', 'main', '--format=%(refname:short)']).then((out) => { if (out != null) pilotMerged.set(project, out.split('\n').map((l) => l.trim()).filter((b) => b.startsWith('escadrille/'))); }); };
const maxSeq = (sql, ...a) => db.prepare(sql).get(...a)?.n || 0;
const projectPlanIds = (project) => db.prepare('select id from plans where project = ? order by created desc').all(project).map((r) => r.id);
const pilotCollect = (project) => {
  const c = pilotOf(project).cursor || { main: 0, log: 0, pend: '' };
  const plans = projectPlanIds(project); const ph = plans.map(() => '?').join(',') || "''";
  const pending = mainchat.pendingOf(db, project).messages;
  const rows = db.prepare(`select * from log where seq > ? and plan in (${ph}) order by seq`).all(c.log, ...plans).map((r) => ({ ...r, stops: parse(r.stops, []) }));
  const prev = new Map(); for (const r of rows) { const k = r.plan + '/' + r.session; if (!prev.has(k)) { const b = db.prepare('select * from log where plan = ? and session = ? and seq <= ? order by seq desc limit 1').get(r.plan, r.session, c.log); if (b) prev.set(k, { ...b, stops: parse(b.stops, []) }); } }
  const events = pilot.eventsOf(rows, prev);
  const waiting = []; const states = [];
  refreshMerged(project); // FIAB 2: git says what is in main, once per wake; the state alone never does
  for (const [i, id] of plans.entries()) { const plan = planOf(id); const st = stateOf(id); if (i < 12) states.push({ id, title: plan?.title || id, sessions: st.map((r) => ({ id: r.id, status: r.status, who: stepOf(plan, r).who })) });
    for (const r of st) for (const e of r.pending || []) if (['reply', 'permission', 'review'].includes(e.kind)) { const s = plan?.sessions.find((x) => x.id === r.id); waiting.push({ plan: id, session: r.id, pendingId: e.id, kind: e.kind, stop: e.stop, stopKind: Number.isInteger(e.stop) ? stopKind(s?.stops?.[e.stop]) : 'info', text: e.text, at: e.at, ...(e.kind === 'permission' ? { tool: e.tool || null, command: asks.commandOf(e.tool, e.input || (e.tool === 'Bash' ? { command: e.text } : {})) } : {}) }); } }
  const refused = pilotRefusals.get(project) || [];
  // Phase 13 PIL, the filter (lib/wake.mjs): what was already carried to a wake, what is only informative, a session still at
  // work and a permission the policy answered do not wake anyone; the keys seen ride in the cursor
  // PIL (3 November, Harbor): every plan of the project, not the 12 latest (an older plan's permissions never woke anyone)
  const rowsNow = {}; for (const id of plans) for (const r of stateOf(id)) rowsNow[id + '/' + r.id] = { status: r.status, health: r.health, done: r.status === 'done' };
  // a key kept for Dev lives while its stop still waits; the watchdog's missed keys pass seen; two sessions waiting for
  // each other are named once, with the one that advances
  const heldNow = (pilotOf(project).held || []).filter((k) => { const [pl, se] = k.split('/'); const r = rowsNow[pl + '/' + se]; return r && r.status !== 'done'; }); // until Dev answers (sessionMessage) or the session ends
  const force = pilotForce.get(project) || []; pilotForce.delete(project);
  const loops = wake.crossWaits(plans.slice(0, 12).flatMap((id) => { const plan = planOf(id); return stateOf(id).map((r) => { const s = plan?.sessions.find((x) => x.id === r.id); const w = waiting.find((x) => x.plan === id && x.session === r.id && x.kind === 'reply'); return { plan: id, id: r.id, status: r.status, after: s?.after || [], state: { why: r.why, claude: r.claude }, waitText: w?.text, fallback: !!(w && Number.isInteger(w.stop) && stopFallback(s?.stops?.[w.stop])), stopKind: w?.stopKind, at: w?.at }; }); }), Array.isArray(c.seen) ? c.seen : []);
  if (loops.length) pilotNotes.set(project, [...(pilotNotes.get(project) || []), ...loops.map((l) => 'Attente croisée : ' + l.why)]);
  // A message that arrived during a turn is not « answered » by that turn's reply (Dev, 2 November: it rides the head of the next wake)
  const held = (pilotHeld.get(project) || []).map((seq) => db.prepare('select seq, text, at from main_messages where seq = ? and project = ?').get(seq, project)).filter(Boolean);
  const toCarry = [...held, ...pending.filter((m) => m.seq > c.main && !routing.has(m.seq) && !held.some((h) => h.seq === m.seq))].sort((a, b) => a.seq - b.seq);
  const mu = pilot.muteWaiting({ waiting, events, muted: (w) => pilotMuted(w.plan, w.session, (stateOf(w.plan).find((r) => r.id === w.session)?.pending || []).find((p) => p.id === w.pendingId)) }); // PIL 6 November
  const cl = wake.classify({ events: mu.events, waiting: mu.waiting, pending: toCarry, rows: rowsNow, seen: Array.isArray(c.seen) ? c.seen : [], held: heldNow, force });
  for (const l of loops) cl.seen.push(l.key);
  if ((pilotOf(project).held || []).length !== heldNow.length) setPilot(project, { held: heldNow });
  if (!cl.judge && !loops.length) { if (events.length || waiting.length) { const p = pilotOf(project); setPilot(project, { cursor: { ...c, seen: cl.seen }, stats: wake.tally(p.stats, 'noise') }); } return null; } // a refusal alone does not wake: it rides the next wake
  pilotRefusals.delete(project); pilotHeld.delete(project);
  const thread = mainchat.listMessages(db, project, { limit: 40 }).messages.reverse();
  const mem = memoryOf(project).lines.slice(-40).map((l) => l.text).filter((l) => l.trim());
  const notes = pilotNotes.get(project) || [];
  const state = { thread, memory: mem, plans: states, merged: pilotMerged.get(project), running: states.flatMap((p) => p.sessions).filter((s) => s.status === 'running').length, mode: (storedSettings(project).autonomy || {}).mode || 'surveille' };
  // the permissions whole (docs/asks.md): pilot.wakePrompt cuts a session's text at 400 characters, this section never cuts
  const prompt = pilot.wakePrompt(i18n.plain({ project, pending: toCarry, events: cl.keep, waiting: cl.waiting, state, notes })) + wake.commandsSection(cl.waiting) + (refused.length ? '\n\n### Refusé à ton dernier tour\n' + refused.map((l) => '- ' + l).join('\n') : '');
  const cursor = { main: maxSeq('select max(seq) as n from main_messages where project = ?', project), log: maxSeq('select max(seq) as n from log'), pend: waiting.reduce((m, w) => (String(w.at || '') > m ? String(w.at) : m), c.pend || ''), seen: cl.seen };
  // What the triage needs, kept for pilotStart: the escalation the code decides, else the Haiku prompt
  pilotPlanned.set(project, { escalate: wake.mustEscalate({ keep: cl.keep, waiting: cl.waiting, pending: toCarry }), triage: wake.triagePrompt({ project, keep: cl.keep, waiting: cl.waiting, plans: states, memory: mem }), state, notes });
  return { prompt, cursor };
};
const pilotPlanned = new Map(); // project → what pilotCollect prepared for the next start
const pilotHeld = new Map(); // project → seqs of the developer's messages that arrived while the pilot was busy
const pilotCanWake = (project) => {
  const p = pilotOf(project); if (!p.on) return { ok: false, why: 'éteint' };
  const { daily } = pilotCaps(project); const spent = pilot.spentToday(p);
  if (spent >= daily) { if (p.cappedDay !== pilot.today()) { setPilot(project, { cappedDay: pilot.today() }); pilotSay(project, 'system', msg('srv.p.capped', { spent: usd(spent), daily: usd(daily) })); } return { ok: false, why: 'plafond du jour' }; }
  if (pilotStall.get(project)?.cap) { pilotStall.delete(project); notify('main:' + project); } // the cap lifted: the pilot is back
  return { ok: true };
};
// Phase 13 PIL: a wake first goes through the triage (lib/wake.mjs) unless the code already knows it needs the pilot (a message of
// Dev, an arrêt de goût, de données, de sécurité ou de release, a review, an error). The waker gets a gate: send(prompt) runs the
// triage on Haiku, then either does the rule alone and ends the turn, or starts the pilot on its model with the triage's summary.
const pilotStart = (project) => ({
  send: (prompt) => {
    const planned = pilotPlanned.get(project) || {}; pilotPlanned.delete(project);
    const stats = (outcome) => setPilot(project, { stats: wake.tally(pilotOf(project).stats, outcome) });
    const toPilot = (triage, outcome) => { stats(outcome); const proc = pilotSpawn(project, planned); if (!proc) { pilotWaker.turnEnded(project); return; } proc.send(triage ? prompt.replace('\n', `\n\n### Le tri (Haiku) a demandé ton jugement\n> ${String(triage).split('\n').slice(0, 6).join('\n> ')}\n`) : prompt); };
    if (planned.escalate || storedSettings(project).pilotTriage === false) return toPilot(null, 'pilot');
    pilotDoing.set(project, { what: 'tri du réveil (Haiku)', since: now() });
    runSmall({ cwd: project, model: wake.TRIAGE_MODEL, systemPrompt: wake.triageSystemPrompt(), budget: wake.TRIAGE_BUDGET, prompt: planned.triage || prompt, timeoutMs: 90000 }).then(({ text, cost }) => {
      const p = pilotOf(project); setPilot(project, { day: pilot.today(), spent: Math.round((pilot.spentToday(p) + (cost || 0)) * 10000) / 10000 });
      const r = wake.parseTriage(text);
      if (!r.ok) return toPilot(`tri illisible (${r.error})`, 'escalated');
      if (r.decision.action === 'escalate') return toPilot(r.decision.summary || 'à juger', 'escalated');
      const done = pilotRule(project, r.decision);
      if (!done.ok) return toPilot(`règle refusée : ${done.why}`, 'escalated');
      pilotRecord({ project, planId: r.decision.plan, sessionId: r.decision.session, kind: 'note', text: `Tri (Haiku) : ${r.decision.do} ${r.decision.session}\n${done.text || r.decision.text || ''}` });
      stats('rule'); pilotDoing.delete(project); pilotWaker.turnEnded(project);
    }).catch((e) => toPilot(`tri indisponible (${e.message})`, 'escalated'));
  },
});
// A rule the triage may apply alone: play the session's QA again, resume a waiting session, relay a message. Never an answer
// to a stop the mode keeps for a human (decideAnswer), never a permission.
const ruleStreak = new Map(); // "plan/session" → rules applied in a row without the pilot or a person: past MAX_RULE_STREAK, the pilot
const MAX_RULE_STREAK = 2;
const pilotRule = (project, d) => {
  const plan = planOf(d.plan); if (!plan || plan.project !== project) return { ok: false, why: 'plan inconnu dans ce projet' };
  const s = plan.sessions.find((x) => x.id === d.session); const row = rowOf(plan.id, d.session); if (!s || !row) return { ok: false, why: 'session inconnue' };
  const sk = keyOf(plan.id, d.session); const streak = (ruleStreak.get(sk) || 0) + 1; if (streak > MAX_RULE_STREAK) return { ok: false, why: `${MAX_RULE_STREAK} règles de suite sur ${d.session} : un jugement` }; ruleStreak.set(sk, streak);
  if (d.do === 'replay-qa') return replayQa(plan.id, d.session) ? { ok: true, text: 'parcours rejoués' } : { ok: false, why: 'aucun parcours joué par cette session' };
  if (row.pending.some((p) => p.kind === 'permission' || p.kind === 'review')) return { ok: false, why: 'une autorisation ou une revue attend' };
  const reply = row.pending.find((p) => p.kind === 'reply');
  if (reply) { const dec = pilot.decideAnswer({ entry: reply, stops: s.stops, mode: autonomyOf(plan).mode }); if (!dec.ok) return { ok: false, why: dec.why }; }
  try { sessionMessage(plan.id, d.session, d.text, { pilot: true, triage: true }); } catch (e) { return { ok: false, why: e.message }; }
  return { ok: true, text: d.text };
};
// The pilot itself, on its model: one process per wake, resumed by --resume until a handoff, fresh after one
const pilotSpawn = (project, planned = {}) => {
  const p = pilotOf(project); const { budget, daily } = pilotCaps(project);
  const cur = { prose: [], refs: [], proposal: null, ended: false, handoff: null, handoffText: [], fresh: !p.sessionId && (p.handoffs || 0) > 0, cost: 0 }; // fresh: a process started after a handoff
  const onEvent = (ev) => {
    pilotLastWord.set(project, now());
    if (ev.type === 'init') { if (ev.sessionId && ev.sessionId !== pilotOf(project).sessionId) setPilot(project, { sessionId: ev.sessionId }); return; }
    if (ev.type === 'text') { if (cur.handoff) { cur.handoffText.push(ev.text); return; } const prose = stripBlocks(ev.text); if (prose) cur.prose.push(prose); for (const b of findBlocks(ev.text)) if (b.kind === 'pilot') pilotBlock(project, b, cur); return; }
    if (ev.type === 'error') { pilotSay(project, 'system', 'Pilote : ' + tail(ev.text, 200)); return; }
    if (ev.type === 'turn') {
      cur.cost = ev.cost || 0; cur.turned = true;
      if (cur.handoff) { pilotHandoffDone(project, cur); pilotEnd(project, cur, cur.cost, daily); return; }
      // Phase 13 PIL, the handoff: past the threshold the same process gets one more turn to write its handoff, then stops for good
      const context = ev.contextWindow ? Math.min(1, (ev.contextInput ?? ev.usage?.input ?? 0) / ev.contextWindow) : null;
      const need = pilothandoff.needsHandoff({ context, cost: cur.cost, thresholds: pilothandoff.thresholdsOf(storedSettings(project)) });
      const L = pilotProcs.get(project);
      if (need.yes && L?.cur === cur && !L.proc.exited) { cur.handoff = { n: (pilotOf(project).handoffs || 0) + 1, why: need.why, context }; pilotDoing.set(project, { what: 'passation', since: now() }); L.proc.send(pilothandoff.handoffRequest({ project, n: cur.handoff.n, why: need.why })); return; }
      pilotEnd(project, cur, cur.cost, daily); return;
    }
    if (ev.type === 'exit') {
      // the cause, always in server.log; a death before any answer also gets one line in the thread (never silent again)
      const answered = cur.prose.length > 0 || cur.turned === true; console.log(pilotdeath.exitLine({ project, code: ev.code, signal: ev.signal, stderr: ev.stderr, answered, cost: cur.cost }));
      if (!answered && !cur.ended && !cur.stopping) pilotSay(project, 'system', `Pilote arrêté sans réponse (code ${ev.code ?? '–'}${ev.signal ? ', ' + ev.signal : ''}) : la cause est dans server.log.`);
      if (pilotProcs.get(project)?.cur === cur) pilotProcs.delete(project); if (!cur.ended) pilotEnd(project, cur, cur.cost, daily);
    }
  };
  try {
    const head = !p.sessionId && p.handoff ? pilothandoff.freshPrompt(p.handoff) : ''; // a fresh pilot starts from the handoff; the wake prompt carries the memory and the plans
    if (head) setPilot(project, { handoff: null });
    const proc = startPlanner({ cwd: project, model: pilotModel(storedSettings(project).pilotModel), systemPrompt: pilot.systemPrompt({ project, port: PORT }) + memorySection(project), resume: p.sessionId || undefined, budget: Math.min(budget, Math.max(0.01, daily - pilot.spentToday(p))), onEvent });
    pilotProcs.set(project, { proc, cur }); pilotDoing.set(project, { what: 'un tour du pilote', since: now() }); pilotNotes.delete(project);
    for (const k of [...ruleStreak.keys()]) if (projectOfPlan(k.split('/')[0]) === project) ruleStreak.delete(k); // the pilot judged: the rules may run again
    return head ? { send: (t) => proc.send(head + t) } : proc;
  } catch (e) { pilotSay(project, 'system', 'Pilote : ' + e.message); return null; }
};
// The handoff turn is over: the block becomes <project>/.escadrille/passation-pilote.md, the Claude session is forgotten (the next
// wake starts fresh), the journal keeps a row, the thread a line
const pilotHandoffDone = (project, cur) => {
  const { n, why } = cur.handoff; const text = pilothandoff.parseHandoff(cur.handoffText.join('\n')) || 'Passation vide : le pilote n’a rien écrit.';
  const file = pilothandoff.handoffFile(project);
  try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text + '\n'); } catch (e) { pilotSay(project, 'system', 'Passation du pilote non écrite : ' + e.message); }
  setPilot(project, { sessionId: null, handoffs: n, handoff: { n, at: now(), text } });
  pilotRecord({ project, kind: 'note', text: `Passation du pilote n°${n} (${why})\n${file}` });
  pilotSay(project, 'system', `Passation du pilote n°${n} (${why}) : le prochain réveil repart d’un processus neuf avec ${file}.`);
  pilotNote(project, `Passation n°${n} faite (${why}).`);
};
const pilotEnd = (project, cur, cost, daily) => {
  if (cur.ended) return; cur.ended = true;
  const p = pilotOf(project); const day = pilot.today(); const spent = Math.round((pilot.spentToday(p, day) + cost) * 10000) / 10000;
  setPilot(project, { day, spent, costs: pilothandoff.pushCost(p.costs, { cost, fresh: cur.fresh, at: now() }) });
  const text = cur.prose.join('\n\n').trim() || (cur.proposal ? cur.proposal.title : '');
  if (text) { pilotSay(project, 'claude', text, { links: pilot.linksFor(project, cur.refs), ...(cur.proposal ? { proposal: cur.proposal } : {}) }); pilotRestarts.answered(project); }
  const L = pilotProcs.get(project); if (L?.cur === cur) { pilotProcs.delete(project); L.proc.stop(); } // one process per wake: its cap is the wake's
  pilotStall.delete(project); // a turn ended: the pilot is back, the watchdog's hand-over ends
  pilotDoing.delete(project);
  if (spent >= daily) pilotCanWake(project);
  pilotWaker.turnEnded(project);
};
// Phase 13 PIL, the triage of the developer's messages (lib/msgtriage.mjs): Haiku, without the pilot's context, says pilot or
// delegate; an action request goes to the pilot whatever it said. The conversation never waits: a delegated question leaves now, a
// pilot-routed message while the pilot is busy gets a line at once and rides the head of the next wake.
const routeMessage = (project, m) => {
  const st = storedSettings(project);
  const tallyMsg = (delegated, cost = 0) => setPilot(project, { messages: msgtriage.tallyMessage(pilotOf(project).messages, { delegated, cost }) });
  const toPilot = (why) => { routing.delete(m.seq); tallyMsg(false); if (pilotWaker.busy(project)) { const d = pilotDoing.get(project); pilotHeld.set(project, [...(pilotHeld.get(project) || []), m.seq]); pilotSay(project, 'system', msgtriage.busyLine({ doing: d?.what || 'un tour', since: d?.since ? d.since.slice(11, 16) : null })); } pilotWaker.wake(project); };
  if (msgtriage.looksLikeAction(m.text) || st.pilotTriage === false) return toPilot('demande d’action');
  routing.add(m.seq);
  const plans = projectPlanIds(project).slice(0, 8).map((id) => ({ id, title: planOf(id)?.title || id, sessions: stateOf(id).map((r) => ({ id: r.id, status: r.status })) }));
  const mem = memoryOf(project).lines.slice(-10).map((l) => l.text).filter((l) => l.trim());
  runSmall({ cwd: project, model: msgtriage.ROUTE_MODEL, systemPrompt: msgtriage.routeSystemPrompt(), budget: msgtriage.ROUTE_BUDGET, prompt: msgtriage.routePrompt({ project, text: m.text, plans, memory: mem }), timeoutMs: 60000 }).then(({ text }) => {
    const d = msgtriage.routeOf({ text: m.text, decision: msgtriage.parseRoute(text, { project }) });
    if (d.route === 'pilot') return toPilot(d.why);
    // Delegated: a short read-only session in the project's sandbox, a bounded budget, signed by its model; the pilot gets one line
    const cap = Number(st.pilotDelegateUsd) > 0 ? Number(st.pilotDelegateUsd) : msgtriage.DELEGATE_BUDGET;
    return runSmall({ cwd: project, model: d.model, systemPrompt: msgtriage.delegateSystemPrompt({ project }), budget: cap, prompt: d.question, timeoutMs: 600000 }).then(({ text: answer, cost }) => {
      routing.delete(m.seq); const a = stripBlocks(answer).trim() || 'Pas de réponse.';
      mainchat.addMessage(db, { project, role: 'claude', text: a + '\n\n' + msgtriage.signature(d.model), source: 'delegate:' + d.model, data: { delegated: { model: d.model, question: d.question, cost } } }); notify('main:' + project);
      pilotNote(project, msgtriage.noteLine({ question: d.question, answer: a, model: d.model }));
      pilotRecord({ project, kind: 'note', text: `Question déléguée à ${msgtriage.NAMES[d.model] || d.model}\n${d.question}\n${a.slice(0, 600)}` });
      tallyMsg(true, cost);
    });
  }).catch((e) => { pilotSay(project, 'system', 'Tri du message impossible : ' + e.message); toPilot('tri indisponible'); });
};
const pilotRefuse = (project, cur, a, why) => {
  const what = `${a.do || 'action'}${a.session ? ' ' + a.session : ''}`;
  pilotRecord({ project, planId: typeof a.plan === 'string' ? a.plan : null, sessionId: a.session || null, kind: 'refuse', text: `${what} refusé : ${why}` });
  pilotSay(project, 'system', `Refusé au pilote : ${what}, ${why}.`);
  pilotRefusals.set(project, [...(pilotRefusals.get(project) || []), `${what} : ${why}`]);
};
const pilotBlock = (project, b, cur) => {
  if (b.error) return pilotRefuse(project, cur, { do: 'bloc' }, 'illisible');
  const { actions, errors } = pilot.validatePilot(b.value);
  for (const e of errors) pilotRefuse(project, cur, { do: 'bloc' }, e);
  for (const a of actions) {
    try { const r = pilotAct(project, a, cur); if (r?.refused) pilotRefuse(project, cur, a, r.refused); }
    catch (e) { pilotRefuse(project, cur, a, e.message); }
  }
};
// PIL (Dev, 6 November, docs/pilot.md « Les garde-fous » 7 to 10): what the pilot may not grant goes to the developer, once
const pilotDenials = pilot.createDenials();
const pilotMuted = (plan, session, e) => e?.kind === 'permission' && pilotDenials.muted(pilot.permissionKey(plan, session, e));
const pilotDenied = (project, planId, sid, entry, d) => {
  const r = pilotDenials.refuse(pilot.permissionKey(planId, sid, entry), { toDev: !!d.dev });
  if (r.first) { pushNotice(planId, sid, 'permission', 'pilot-dev:' + entry.id, { human: true, why: d.why || 'refusée deux fois', text: pilot.commandText(entry) }); pilotRecord({ project, planId, sessionId: sid, kind: 'note', text: `Vers « À toi » : ${pilot.commandText(entry).slice(0, 300)}\n${d.why || 'refusée deux fois'}` }); notify('plan:' + planId); }
};
const pilotAskDev = (project, cur, planId, sid, text, why) => { // the contract: a widening becomes a question to the developer
  pilotSay(project, 'system', `Question pour toi : le pilote veut écrire à ${sid} « ${String(text).slice(0, 400)} », ${why}. Envoie-le toi-même à la session si tu es d'accord.`, { links: pilot.linksFor(project, [{ kind: 'flow', plan: planId, session: sid }]) });
  pushNotice(planId, sid, 'reply', 'pilot-scope:' + Date.now(), { human: true, why, text: String(text).slice(0, 200) });
  pilotRecord({ project, planId, sessionId: sid, kind: 'refuse', text: `message ${sid} gardé pour Dev : ${why}` });
  pilotRefusals.set(project, [...(pilotRefusals.get(project) || []), `message ${sid} : ${why}, question posée à Dev`]); return null;
};
const pilotPlan = (project, id) => { const plan = planOf(id); if (!plan || plan.project !== project) throw new Error('plan inconnu dans ce projet'); return plan; };
const pilotAct = (project, a, cur) => {
  if (a.plan && typeof a.plan === 'string' && ['answer', 'message', 'budget', 'capture'].includes(a.do) && isRetired(planOf(a.plan))) return { refused: i18n.plain(msg('srv.e.retired')) };
  if (a.do === 'answer') {
    const plan = pilotPlan(project, a.plan); const s = plan.sessions.find((x) => x.id === a.session); const row = rowOf(plan.id, a.session); if (!s || !row) return { refused: 'session inconnue' };
    const entry = row.pending.find((p) => p.id === a.pendingId);
    const d = pilot.decideAnswer({ entry, stops: s.stops, mode: autonomyOf(plan).mode, allow: a.allow });
    if (entry?.kind === 'permission' && (d.dev || a.allow === false)) pilotDenied(project, plan.id, s.id, entry, d); // PIL 6 November: the anti-loop
    if (!d.ok) return { refused: d.why };
    if (entry.kind === 'reply') { const sc = pilot.scopeCheck({ text: a.text, brief: [plan.goal, s.prompt].join('\n') }); if (!sc.ok) return pilotAskDev(project, cur, plan.id, s.id, a.text, sc.why); }
    if (entry.kind === 'permission') sessionAnswer(plan.id, s.id, { id: entry.id, allow: a.allow, message: a.text || undefined });
    else sessionMessage(plan.id, s.id, a.text, { pilot: true });
    pilotRecord({ project, planId: plan.id, sessionId: s.id, kind: 'answer', text: msg('srv.p.answered', { s: s.id, text: a.text }) });
    cur.refs.push({ kind: 'flow', plan: plan.id, session: s.id }); return null;
  }
  if (a.do === 'message') {
    const plan = pilotPlan(project, a.plan); const ps = plan.sessions.find((x) => x.id === a.session);
    const sc = pilot.scopeCheck({ text: a.text, brief: [plan.goal, ps?.prompt].join('\n') }); if (!sc.ok) return pilotAskDev(project, cur, plan.id, a.session, a.text, sc.why);
    sessionMessage(plan.id, a.session, a.text, { pilot: true });
    pilotRecord({ project, planId: plan.id, sessionId: a.session, kind: 'message', text: msg('srv.p.message', { s: a.session, text: a.text }) });
    cur.refs.push({ kind: 'flow', plan: plan.id, session: a.session }); return null;
  }
  if (a.do === 'memory') { addMemory({ project, line: a.line }); pilotRecord({ project, kind: 'memory', text: msg('srv.p.memory', { line: a.line }) }); cur.refs.push({ kind: 'memory' }); return null; }
  if (a.do === 'propose') {
    const { plan, errors } = validatePlan(withSettings({ ...a.plan, project }, project), { path: project, model: plannerModel(settingsOf(project).model), idPrefix: new Date().toISOString().slice(0, 10), project });
    if (errors) return { refused: 'plan : ' + errors.slice(0, 3).join(' ; ') };
    if (planOf(plan.id) && stateOf(plan.id).some((r) => !['todo', 'later'].includes(r.status))) return { refused: `le plan ${plan.id} est déjà lancé` };
    { // FIAB 2: a running session is not relaunched, a branch git has in main is not merged again
      const known = projectPlanIds(project).slice(0, 30).flatMap((id) => { const p = planOf(id); return stateOf(id).map((r) => ({ plan: id, id: r.id, status: r.status, branch: r.worktree?.branch || null, who: stepOf(p, r).who })); });
      const pc = pilot.proposalCheck({ plan, sessions: known, merged: pilotMerged.get(project) || [] }); if (!pc.ok) return { refused: pc.why }; }
    plan.pilot = true;
    writeFileSync(path.join(PLANS_DIR, plan.id + '.json'), JSON.stringify(plan, null, 1)); upsertPlan(plan);
    const est = estimateOf(plan);
    cur.proposal = { planId: plan.id, title: plan.title, sessions: plan.sessions.map((s) => ({ id: s.id, name: s.name, model: s.model, budget: budgetOf(s), wave: s.wave })), waves: plan.waves.length, estimate: { cost: est?.total?.cost ?? null, budget: sumBudgets(plan), weeklyAfter: est?.total?.weeklyAfter ?? null }, stops: plan.sessions.reduce((n, s) => n + (s.stops || []).length, 0), network: plan.network || [], missing: domains.missingFrom(projectNetwork(plan.project || null), plan.network || []), status: 'proposed' }; // network: what the plan announces; missing: not in the project's list
    pilot.replaceProposals(db, project);
    pilotRecord({ project, planId: plan.id, kind: 'propose', text: msg('srv.p.proposed', { title: plan.title }) });
    cur.refs.push({ kind: 'plan', plan: plan.id, title: plan.title }); notify('plan:' + plan.id); return null;
  }
  if (a.do === 'capture') { // session B's tool (lib/capture.mjs): a local URL, or a .html under the project or one of its worktrees
    const roots = [...db.prepare('select s.worktree from sessions s join plans p on p.id = s.plan where p.project = ?').all(project).map((r) => parse(r.worktree)?.path).filter(Boolean), project];
    const root = roots.find((r) => a.target.startsWith(r + '/')) || project;
    captureTarget({ target: a.target, worktree: root, name: 'pilote-' + folderName(null, a.target) }).then((r) => {
      if (!r.ok) return pilotRefuse(project, cur, a, r.error);
      pilotRecord({ project, kind: 'capture', text: `Capture de ${a.target}\n${r.dir}` });
      pilotSay(project, 'system', captureNote(r, a.target), { links: pilot.linksFor(project, [{ kind: 'file', path: r.dir }]) });
    }).catch((e) => pilotRefuse(project, cur, a, e.message));
    return null;
  }
  if (a.do === 'budget') { // Phase 13 PIL (Dev, 2 November): the pilot raises a session's cap without asking while the Mac's weekly threshold holds
    const plan = pilotPlan(project, a.plan); const s = plan.sessions.find((x) => x.id === a.session); const row = rowOf(plan.id, a.session); if (!s || !row) return { refused: 'session inconnue' };
    if (['todo', 'later'].includes(row.status)) return { refused: 'session non lancée' };
    const old = budgetOf(s); if (a.usd <= old) return { refused: `${usd(a.usd)} ne monte pas le plafond (${usd(old)})` };
    const wk = limitRowsNow(project).find((r) => r.kind === 'weekly'); if (wk && ['soft', 'hard'].includes(wk.level)) return { refused: `seuil hebdo du Mac franchi (${Math.round(wk.pct)} %) : demande à Dev` };
    const r = sessionBudget(plan.id, s.id, a.usd);
    pilotRecord({ project, planId: plan.id, sessionId: s.id, kind: 'note', text: `Budget de ${s.id} relevé à ${usd(a.usd)}\n${r.restarted ? 'processus relancé avec le nouveau plafond' : 'appliqué au prochain départ'}` });
    pilotSay(project, 'system', `Budget de ${s.id} relevé de ${usd(old)} à ${usd(a.usd)}${wk ? ` (hebdo à ${Math.round(wk.pct)} %, sous le seuil)` : ''}.`);
    cur.refs.push({ kind: 'flow', plan: plan.id, session: s.id }); return null;
  }
  if (a.do === 'launch') {
    if ((storedSettings(project).autonomy || {}).mode !== 'autonome') return { refused: 'lancer seul : mode Autonome seulement' };
    pilotAccept({ project, seq: a.seq }, { by: 'pilot' }).catch((e) => pilotRefuse(project, cur, a, e.message)); return null;
  }
  return { refused: 'action inconnue' };
};
const pilotAccept = async (b, { by = 'dev' } = {}) => {
  const project = projectArg(b.project); const m = db.prepare('select * from main_messages where project = ? and seq = ?').get(project, Number(b.seq));
  const data = parse(m?.data, null); const prop = data?.proposal;
  if (!prop) throw new Error('carte inconnue'); if (prop.status !== 'proposed') throw new Error(`carte ${prop.status === 'launched' ? 'déjà lancée' : 'remplacée'}`);
  if (by === 'pilot' && prop.network?.length) throw new Error('un plan avec des domaines attend le clic de Dev');
  const plan = planOf(prop.planId); if (!plan || plan.project !== project) throw new Error('plan introuvable');
  if (by === 'pilot') { const c = pilot.planCapCheck({ cost: Math.max(Number(prop.estimate?.cost) || 0, sumBudgets(plan)) || null, cap: storedSettings(project).pilotPlanCapUsd }); if (!c.ok) throw new Error(c.why); } // PIL 6 November
  pilot.setProposalStatus(db, m.seq, 'launched'); // first, so a double click launches once
  let r; try { r = await launch({ plan: plan.id }); } catch (e) { pilot.setProposalStatus(db, m.seq, 'proposed'); throw e; }
  const n = r.launched.length + r.queued.length; const cost = prop.estimate?.cost ?? prop.estimate?.budget ?? sumBudgets(plan);
  pilotSay(project, 'system', msg(by === 'pilot' ? 'srv.p.launchedByPilot' : 'srv.p.launched', { n, waves: msg('srv.p.waves', { n: plan.waves.length }), cost: usd(cost) }), { links: pilot.linksFor(project, [{ kind: 'plan', plan: plan.id, title: plan.title }]) });
  if (by === 'dev') pilotRecord({ project, planId: plan.id, kind: 'launch', text: msg('srv.p.devLaunched', { title: plan.title }) }); else pilotRecord({ project, planId: plan.id, kind: 'launch', text: msg('srv.p.aloneLaunched', { title: plan.title }) });
  return { ok: true, plan: plan.id, ...r };
};
const pilotWaker = pilot.createWaker({ start: pilotStart, collect: pilotCollect, canWake: pilotCanWake, onCursor: (project, cursor) => setPilot(project, { cursor }), debounceMs: num(vars.PILOT_DEBOUNCE_MS, 1500), eventWindowMs: num(vars.PILOT_EVENT_WINDOW_MS, 150000) }); // Phase 14 RAF: events 2 min 30 apart, one wake
// PIL (Dev, 3 November 17:35, and the night): the watchdog, every 30 s (lib/pilotwatch.mjs). What waits for the pilot in every
// plan of the project; a policy allow applied at once (4); a missed request wakes the pilot, two wakes without effect restart
// it (5); a pilot that cannot wake or stays mute hands the requests to « À toi » and the phone, the reason in one line.
const pilotRequests = (project) => {
  const out = pilotwatch.requestsOf({ plans: projectPlanIds(project).map((id) => planOf(id)).filter(Boolean), rowsOf: stateOf, stopKindOf: stopKind }).filter((r) => (r.kind !== 'reply' || !wake.isGabStop(r)) && !pilotMuted(r.plan, r.session, r));
  for (const m of mainchat.pendingOf(db, project).messages) out.push({ key: 'main:' + m.seq, kind: 'message', at: m.at, text: m.text });
  return out;
};
const pilotPolicyNow = (project) => {
  const reqs = pilotRequests(project);
  for (const { r, d } of pilotwatch.policyAllows({ on: pilotpolicy.policyOn(storedSettings(project)), requests: reqs, decide: pilotpolicy.decidePolicy })) {
    try { sessionAnswer(r.plan, r.session, { id: r.id, allow: true, auto: true, reason: d.reason }); pilotRecord({ project, planId: r.plan, sessionId: r.session, kind: 'answer', text: pilotpolicy.logText(r, d) }); } catch (e) { console.error('pilotwatch policy', e.message); }
  }
};
// (c) two restarts without an answer between them: the third cuts the pilot (off), « À toi » says it in one line with « Relancer »
const pilotRestarts = pilotdeath.createRestartGuard();
const pilotCut = (project) => {
  const L = pilotProcs.get(project); try { L?.proc.stop(); } catch {} pilotProcs.delete(project); pilotDoing.delete(project); pilotWaker.reset(project);
  setPilot(project, { on: false }); const reason = `coupé après ${pilotdeath.MAX_RESTARTS} relances sans effet`;
  pilotStall.set(project, { reason, at: now(), cut: true }); console.log(`pilot ${project}: ${reason}`);
  pilotRecord({ project, kind: 'note', text: `Chien de garde : pilote ${reason}` }); pilotSay(project, 'system', `Pilote ${reason} : « Relancer le pilote » dans À toi.`); notify('main:' + project);
};
// POST /api/pilot/retry { project }: the button of « À toi »; the pilot on again, a fresh process, the waiting messages carried
const pilotRetry = (project) => {
  const L = pilotProcs.get(project); try { L?.proc.stop(); } catch {} pilotProcs.delete(project); pilotDoing.delete(project);
  pilotRestarts.reset(project); pilotStall.delete(project); if (!pilotOf(project).on) setPilot(project, { on: true });
  pilotWaker.reset(project); pilotForce.set(project, mainchat.pendingOf(db, project).messages.map((m) => 'main:' + m.seq));
  pilotRecord({ project, kind: 'note', text: 'Pilote relancé par le développeur' }); pilotWaker.now(project); notify('main:' + project);
  return { ok: true, pilot: pilotView(project) };
};
const pilotRestart = (project) => {
  if (pilotRestarts.restarted(project).cut) return pilotCut(project);
  const L = pilotProcs.get(project); try { L?.proc.stop(); } catch {} pilotProcs.delete(project); pilotDoing.delete(project);
  pilotWaker.reset(project); pilotRecord({ project, kind: 'note', text: 'Chien de garde : pilote relancé (deux réveils sans effet)' }); pilotWaker.now(project);
};
const pilotDog = pilotwatch.createWatchdog({
  projects: () => db.prepare('select project from project_settings').all().map((r) => r.project).filter((p) => { const on = pilotOf(p).on; if (on) pilotPolicyNow(p); return on; }),
  list: pilotRequests,
  state: (project) => { const p = pilotOf(project); const d = pilotDoing.get(project); return { on: !!p.on, busy: pilotWaker.busy(project), busySince: d?.since || null, lastWord: pilotLastWord.get(project) || null, canWake: pilotCanWake(project), seen: p.cursor?.seen || [] }; },
  wake: (project, keys) => { pilotForce.set(project, keys); pilotWaker.now(project); },
  restart: pilotRestart,
  // FRU (MUET, 6 November): the daily cap is said to Dev, not only in the thread: the pilot counts as absent (« À toi » shows the
  // reason, the next permissions and replies reach the phone at once instead of waiting for the watchdog), until it can wake again
  warn: (project, reason) => { pilotStall.set(project, { reason, at: now(), cap: true }); notify('main:' + project); pilotRecord({ project, kind: 'note', text: `Chien de garde : ${reason}, les demandes vont à « À toi »` }); },
  escalate: (project, reqs, reason) => {
    pilotStall.set(project, { reason, at: now() }); notify('main:' + project);
    for (const r of reqs) if (r.plan) pushNotice(r.plan, r.session, r.kind === 'permission' ? 'permission' : 'reply', 'watch:' + r.pendingId, { human: true, why: reason, text: reason });
    pilotRecord({ project, kind: 'note', text: `Chien de garde : ${reqs.length} demande${reqs.length > 1 ? 's' : ''} vers « À toi » (${reason})` });
  },
});
if (vars.PILOT_WATCH !== 'off') pilotDog.start(setInterval, num(vars.PILOT_WATCH_MS, pilotwatch.TICK_MS));
pilotHook = (planId) => { const project = projectOfPlan(planId); if (project && pilotOf(project).on) pilotWaker.wake(project, { urgent: false }); }; // an event waits its window; Dev's message (routeMessage) does not
const pilotSwitch = (b) => {
  const project = projectArg(b.project); if (typeof b.on !== 'boolean') throw new Error('on : true ou false');
  if (!b.on) { pilotProcs.get(project)?.proc.stop(); pilotProcs.delete(project); pilotWaker.reset(project); setPilot(project, { on: false }); return { ok: true, pilot: pilotView(project) }; }
  // Lit: what happened while it was off is in the state, not replayed; the developer's unanswered messages are
  const lastClaude = maxSeq("select max(seq) as n from main_messages where project = ? and role = 'claude'", project);
  setPilot(project, { on: true, cursor: { main: lastClaude, log: maxSeq('select max(seq) as n from log'), pend: now() } });
  pilotWaker.wake(project);
  return { ok: true, pilot: pilotView(project) };
};
const pilotSettings = (b) => {
  const project = projectArg(b.project); const st = storedSettings(project);
  for (const k of ['pilotBudget', 'pilotDaily', 'pilotHandoffUsd', 'pilotDelegateUsd', 'pilotPlanCapUsd']) if (b[k] !== undefined) { if (b[k] === null) delete st[k]; else { const n = Number(b[k]); if (!Number.isFinite(n) || n <= 0 || typeof b[k] === 'boolean') throw new Error(`${k} : un nombre de dollars > 0`); st[k] = n; } }
  if (b.pilotModel !== undefined) { if (b.pilotModel === null || b.pilotModel === '') delete st.pilotModel; else if (typeof b.pilotModel !== 'string' || !isModel(b.pilotModel)) throw new Error(`pilotModel : modèle inconnu « ${String(b.pilotModel).slice(0, 60)} », choisir un modèle de GET /api/models (null remet Sonnet)`); else st.pilotModel = b.pilotModel; }
  if (b.pilotHandoffContext !== undefined) { if (b.pilotHandoffContext === null) delete st.pilotHandoffContext; else { const n = Number(b.pilotHandoffContext); if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error('pilotHandoffContext : une part de la fenêtre entre 0 et 1'); st.pilotHandoffContext = n; } }
  for (const k of ['pilotPolicy', 'pilotTriage']) if (b[k] !== undefined) { if (b[k] === null) delete st[k]; else if (typeof b[k] !== 'boolean') throw new Error(`${k} : true ou false`); else st[k] = b[k]; } // phase 13 PIL: the policy (off by default), the triage (on)
  db.prepare('insert into project_settings (project, json, at) values (?, ?, ?) on conflict(project) do update set json = excluded.json, at = excluded.at').run(project, JSON.stringify(st), now());
  return { ok: true, pilot: pilotView(project) };
};

// ---------------------------------------------------------------- the limits and their thresholds (docs/limits.md, lib/limits.mjs)
// The windows the sessions' stream carries (every rate_limit_event, lib/planner.mjs): with the measurer's, the newest wins.
// The thresholds: the Mac's (project_settings row '*'), else the defaults; a project may only be stricter.
const MAC_KEY = '*';
let streamWindows = null;
const noteWindows = (ev) => { if (!ev.windows) return; streamWindows = { at: now(), weekly: ev.windows.weekly, fiveHour: ev.windows.fiveHour, models: ev.windows.models || {} }; setImmediate(limitsTick); };
const newestWindows = (measured) => { const a = measured || null; const b = streamWindows; if (!a || !b) return a || b; const [n, o] = String(a.at) >= String(b.at) ? [a, b] : [b, a]; return { ...status.mergeWindows(n, o), at: n.at }; };
// The base's weekly share is dated by the row's last change, not by the reading: once this server has read a stream,
// that reading is the newest (every event passes here), so the base speaks only before the first one
const quotaNow = () => (streamWindows && streamWindows.weekly ? null : weeklyNow(db));
const macLimits = () => storedSettings(MAC_KEY).limits || {};
const thresholdsOf = (project) => limits.effectiveThresholds(macLimits(), project ? storedSettings(project).limits || {} : {});
const planCapOf = (plan) => autonomyOf(plan).planCapUsd ?? sumBudgets(plan);
// The share of the week (phase 11 PS, lib/limits.mjs): the project's own max (no Mac level), and what its sessions and
// planners cost since the last weekly reset (usage.cost in the base; a session that ran across the reset counts whole,
// the cautious side). The value of a point is read at most once a minute (it scans the transcripts).
let dppCache = null;
const dollarsPerPctNow = () => { if (dppCache && Date.now() - dppCache.t < 60e3) return dppCache.v; const v = calibrationNow()?.dollarsPerPct ?? null; dppCache = { t: Date.now(), v }; return v; };
const shareMaxOf = (project) => (project ? limits.validateShare(storedSettings(project).share).value : null);
const projectSpentSince = (project, since) => {
  if (!since) return 0; let usd = 0;
  for (const r of db.prepare('select s.usage from sessions s join plans p on p.id = s.plan where p.project is ? and s.at >= ?').all(project, since)) usd += parse(r.usage)?.cost || 0;
  for (const r of db.prepare('select usage from escadrilles where project is ? and at >= ?').all(project, since)) usd += parse(r.usage)?.cost || 0;
  return Math.round(usd * 100) / 100;
};
const shareOf = (project, claude) => {
  const maxPct = shareMaxOf(project); if (!maxPct) return null;
  const resetsAt = claude && claude.weekly ? claude.weekly.resetsAt : null;
  return { maxPct, resetsAt, spentUsd: projectSpentSince(project, limits.shareSince(resetsAt)), dollarsPerPct: dollarsPerPctNow() };
};
// The rows of a project now: the account's windows, its active burst, its share of the week, and a plan when one is named
const limitRowsNow = (project, { plan = null, burst: b = undefined } = {}) => {
  const claude = status.limitsOf({ quota: quotaNow(), measured: newestWindows(statusMeasurer.last()) });
  const active = b !== undefined ? b : burst.activeBursts(db).find((x) => x.project === project) || null;
  const run = plan ? { title: plan.title || plan.id, usd: planCost(plan.id), capUsd: planCapOf(plan) } : null;
  return limits.rowsOf({ claude, burst: active ? { ...active, spentUsd: burstSpent(active) } : null, run, share: shareOf(project, claude), thresholds: thresholdsOf(project) });
};
// Before each launch: above a soft threshold nothing new starts, the session waits in the queue with the line
// (a model's row holds back that model's sessions only: Fable above its soft threshold leaves Opus starting)
const limitsGuard = (plan, session = null) => { const v = limits.verdictOf(limitRowsNow(projectOfPlan(plan.id), { plan }).filter((r) => !session || limits.rowTouches(r, session.model))); return v.level === 'ok' ? null : { ok: false, why: v.line }; };
// Above a hard threshold: every process the server launched for the project stops, each says which limit did it
// A model's row (row.kind 'model') touches that model's sessions and planners only (limits.rowTouches), every other row all
const sessionModelOf = (pid, sid) => planOf(pid)?.sessions.find((s) => s.id === sid)?.model || null;
const stopAllFor = (project, line, planId = null, row = null) => {
  for (const k of [...live.keys()]) { const [pid, sid] = k.split('/'); if (planId ? pid !== planId : projectOfPlan(pid) !== project) continue;
    if (!limits.rowTouches(row, sessionModelOf(pid, sid))) continue;
    if (!stopProcess(pid, sid)) continue;
    setState(pid, sid, { mode: null, health: 'error', why: line, claude: line }); addSessionMessage(pid, sid, 'system', msg('lim.stopped', { line })); }
  if (planId) return;
  for (const [id, p] of planners) { const e = escadrilleOf(id); if (!p || p.exited || !e || e.project !== project || !limits.rowTouches(row, e.model)) continue; p.stop(); setEscadrille(id, { status: 'stopped' }); addMessage(id, 'error', msg('lim.stopped', { line })); touch(id); }
};
// The pause (phase 10 P, docs/limits.md « La pause »): above the hard threshold of a window that resets (5 h, weekly,
// a model's weekly), each session the server launched for the project stops its process and turns « paused », the
// limit and its reset in the row (so a restart of the server keeps it); it resumes alone with --resume and PAUSE_TEXT
// at that reset, or as soon as a reading puts that limit back under its soft threshold (a threshold raised in Access).
// « Tout reprendre » (POST /api/limits/resume) resumes them at once and lets the limits then crossed run until their
// reset. The sessions not launched stay in the queue (limitsGuard). A dollar cap (burst, plan) still stops.
const PAUSE_TEXT = 'Pause levée, reprends là où tu en étais.';
const PAUSE_TICK_MS = num(vars.PAUSE_TICK_MS, 30000);
const pauseForced = new Map(); // project -> [{ limit, until }]: the limits « Tout reprendre » let run until their reset
const isForced = (project, r) => (pauseForced.get(project) || []).some((f) => f.limit === r.id && f.until === (r.resetsAt || null));
// Only a pause a limit set comes back (2026-11-05: « Tout reprendre » relaunched a closed QA and a later lot, out of the
// order wanted): status 'paused' with its pause and limit, the worktree neither merged nor removed, the review not
// refused nor closed, the session still in its plan, the burst of the plan not over. Any other row stays as it is.
const limitPaused = (planId, row) => {
  if (!row || row.status !== 'paused' || !row.pause?.limit) return false;
  if (row.worktree?.merged || row.worktree?.removed || row.review?.verdict === 'reject' || row.review?.closedBy) return false;
  if (!planOf(planId)?.sessions.some((x) => x.id === row.id)) return false;
  return !burst.finishedPlans(db).has(planId);
};
const pausedRows = (project) => db.prepare("select s.plan, s.id from sessions s join plans p on p.id = s.plan where p.project is ? and s.status = 'paused' order by p.created, s.id").all(project)
  .filter((r) => limitPaused(r.plan, rowOf(r.plan, r.id)));
const pad2 = (n) => String(n).padStart(2, '0');
const whenOf = (iso) => { const d = new Date(iso); if (!iso || isNaN(d)) return null; const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; return d - Date.now() < 20 * 36e5 ? hm : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`; };
const pauseLines = (p) => { const t = whenOf(p.until); return t ? { claude: msg('lim.pausedClaude', { line: p.line, t }), message: msg('lim.paused', { line: p.line, t }) } : { claude: msg('lim.pausedClaudeOpen', { line: p.line }), message: msg('lim.pausedOpen', { line: p.line }) }; };
const pauseAllFor = (project, row, line) => {
  const pause = limits.pauseOf(row, line, now()); const said = pauseLines(pause);
  for (const k of [...live.keys()]) { const [pid, sid] = splitKey(k); if (projectOfPlan(pid) !== project || !limits.rowTouches(row, sessionModelOf(pid, sid))) continue;
    const cur = rowOf(pid, sid); if (!cur || cur.mode !== 'page' || !['running', 'waiting'].includes(cur.status)) continue;
    if (!stopProcess(pid, sid)) continue;
    setState(pid, sid, { status: 'paused', mode: null, pause: { ...pause, was: cur.status }, claude: said.claude, pending: cur.pending.filter((p) => p.kind !== 'permission') });
    addSessionMessage(pid, sid, 'system', said.message); }
  for (const [id, p] of planners) { const e = escadrilleOf(id); if (!p || p.exited || !e || e.project !== project || !limits.rowTouches(row, e.model)) continue; p.stop(); setEscadrille(id, { status: 'stopped' }); addMessage(id, 'error', msg('lim.stopped', { line })); touch(id); }
};
// A paused session back: the process again with --resume; a turn cut by the pause gets PAUSE_TEXT, a session that was
// waiting for the developer waits again. A session of a burst that is over is not resumed (burst.finishedPlans).
const resumePaused = (planId, sid, why) => {
  const plan = planOf(planId); const s = plan?.sessions.find((x) => x.id === sid); const row = rowOf(planId, sid); if (!limitPaused(planId, row)) return false;
  const was = row.pause?.was === 'waiting' ? 'waiting' : 'running';
  if (!s || !row.sessionId || burst.finishedPlans(db).has(planId)) { setState(planId, sid, { status: 'waiting', mode: null, claude: msg('lim.notResumed') }); addSessionMessage(planId, sid, 'system', msg('lim.notResumed')); return false; }
  try {
    const proc = procOf(planId, sid) || startProcess(plan, s, row);
    const line = msg(why === 'forced' ? 'lim.resumedForced' : 'lim.resumed');
    setState(planId, sid, { status: was, mode: 'page', claude: line });
    addSessionMessage(planId, sid, 'system', line);
    if (was === 'running') proc.send(PAUSE_TEXT);
    return true;
  } catch (e) { addSessionMessage(planId, sid, 'system', 'Reprise impossible : ' + e.message); setState(planId, sid, { status: 'waiting', mode: null, health: 'error', why: e.message }); return false; }
};
// At each reading (and each PAUSE_TICK_MS, since a reset needs no reading): resume or hold each paused session
const pauseCheck = (project, rows) => {
  let resumed = 0;
  for (const r of pausedRows(project)) {
    const row = rowOf(r.plan, r.id);
    const step = limits.pauseStep(row.pause, rows, Date.now(), (x) => isForced(project, x));
    if (step.action === 'resume') { if (resumePaused(r.plan, r.id, step.why)) resumed++; }
    else if (step.changed) setState(r.plan, r.id, { pause: { ...step.pause, was: row.pause.was }, claude: pauseLines(step.pause).claude });
  }
  if (resumed) { console.log('limits', project, 'resumed', resumed); advanceQueue(project).catch((e) => console.error('queue', e)); }
};
// « Tout reprendre »: every paused session of the project now, whatever the limits say
const resumeAll = (project) => {
  const rows = limitRowsNow(project);
  pauseForced.set(project, [...(pauseForced.get(project) || []), ...limits.hardPausable(rows).map((r) => ({ limit: r.id, until: r.resetsAt || null }))]);
  const sessions = []; for (const r of pausedRows(project)) if (resumePaused(r.plan, r.id, 'forced')) sessions.push(nameOfPaused(r));
  if (sessions.length) advanceQueue(project).catch((e) => console.error('queue', e));
  return { ok: true, resumed: sessions.length, sessions };
};
const nameOfPaused = (r) => { const s = planOf(r.plan)?.sessions.find((x) => x.id === r.id); return { plan: r.plan, id: r.id, name: s?.name || r.id }; };
// The pause of a project as the Flow shows it: how many, which limit, until when
const pauseSummaryOf = (project) => {
  const ids = pausedRows(project); const rows = ids.map((r) => rowOf(r.plan, r.id)); if (!rows.length) return null;
  const p = rows.map((r) => r.pause).sort((a, b) => String(b.until || '9').localeCompare(String(a.until || '9')))[0]; // the latest reset: when all are back
  return { n: rows.length, sessions: ids.map(nameOfPaused), limit: p.limit, name: limits.rowName({ kind: p.kind, label: p.label }), line: p.line, until: p.until || null };
};
// At each reading of the usage (a stream event, a measure, the burst tick): the crossings act once each
const limitsWatch = limits.createWatch();
const limitsTick = () => {
  try {
    sweepLimits();
    const projects = new Set([...live.keys()].map((k) => projectOfPlan(splitKey(k)[0])));
    for (const [id, p] of planners) if (p && !p.exited) projects.add(escadrilleOf(id)?.project);
    for (const b of burst.activeBursts(db)) projects.add(b.project);
    for (const r of db.prepare("select distinct p.project from sessions s join plans p on p.id = s.plan where s.status = 'paused'").all()) projects.add(r.project);
    for (const project of projects) {
      if (!project) continue;
      const rows = limitRowsNow(project);
      const v = limits.verdictOf(rows);
      const t = limitsWatch.observe(project, v);
      if (v.level === 'hard') {
        // every window above its hard threshold acts, the worst first: a model's on that model, the others on all
        const cap = rows.find((r) => r.level === 'hard' && !limits.pausable(r));
        if (cap) stopAllFor(project, limits.verdictOf([cap]).line, null, cap); else for (const win of limits.hardPausable(rows, (r) => isForced(project, r))) pauseAllFor(project, win, limits.verdictOf([win]).line);
      }
      if (t) console.log('limits', project, t, i18n.plain(v.line || ''));
      pauseCheck(project, rows);
      // a plan above its own hard threshold stops alone
      for (const pid of new Set([...live.keys()].map((k) => splitKey(k)[0]))) { if (projectOfPlan(pid) !== project) continue; const plan = planOf(pid); if (!plan) continue;
        const row = limitRowsNow(project, { plan, burst: null }).find((r) => r.id === 'plan'); if (row && row.level === 'hard') stopAllFor(project, limits.verdictOf([row]).line, pid); }
    }
  } catch (e) { console.error('limits', e); }
};
setInterval(limitsTick, PAUSE_TICK_MS).unref();
// A session said 'running' with no process behind it (lib/running.mjs orphans: a start that failed, a restart with no
// session_id, PX on 2026-11-02 for two hours) goes back to 'waiting' with one line for the pilot, never a reply for the
// developer; at start and at each tick
const reapOrphans = () => {
  const rows = db.prepare("select plan, id, status, mode from sessions where status = 'running'").all();
  for (const r of running.orphans(rows, (p, s) => !!procOf(p, s) || starting.has(keyOf(p, s)))) {
    try { const row = rowOf(r.plan, r.id); setState(r.plan, r.id, { status: 'waiting', mode: null, pending: [...row.pending.filter((p) => p.kind !== 'permission' && p.kind !== 'reply'), { id: fid('info'), kind: 'info', text: msg('srv.s.noProcess'), at: now() }] }); addSessionMessage(r.plan, r.id, 'system', msg('srv.s.noProcess')); notify('running'); } catch (e) { console.error('orphan', e); }
  }
};
setInterval(reapOrphans, PAUSE_TICK_MS).unref();
// A merge by hand happens outside the server: the plans with a finished, unmerged branch and a session still 'later' look again
// (each plan with a stopped, unmerged worktree, or one merged outside that may have moved on, is read again)
const handMergeTick = async () => {
  const plans = db.prepare("select distinct plan from sessions where worktree is not null and status not in ('running', 'todo', 'later')").all();
  for (const { plan } of plans) {
    if (!planOf(plan)) continue; // its sessions outlive a plan retired out of the table: nothing to merge nor launch (it threw every tick)
    try {
      const rows = stateOf(plan); if (!rows.some((r) => r.worktree && !OUTSIDE_SKIP.has(r.status) && (!r.worktree.merged || r.worktree.outside))) continue;
      if ((await syncMerged(plan)).length || rows.some((r) => r.status === 'later')) await checkWaves(plan);
    } catch (e) { console.error('merged outside', e); }
  }
};
setInterval(() => handMergeTick().catch(() => {}), PAUSE_TICK_MS).unref();
// GET /api/limits?project= and POST /api/limits { scope: 'mac' | 'project', project?, limits } or { project, share: n | null }
// A threshold with an end date (`until`, lib/limits.mjs expireThresholds): at its hour it goes back to its previous value
// alone, and the pilot's journal says so (the project's, or every known project's for the Mac). At each tick and read.
const sweepLimits = () => {
  for (const { project: key, json } of db.prepare(`select project, json from project_settings where json like '%"until"%'`).all()) {
    const st = parse(json, {}); const { value, expired } = limits.expireThresholds(st.limits, Date.now()); if (!expired.length) continue;
    if (!Object.keys(value).length) delete st.limits; else st.limits = value;
    db.prepare('update project_settings set json = ?, at = ? where project = ?').run(JSON.stringify(st), now(), key);
    const where = key === MAC_KEY ? knownProjects().map((p) => p.path) : [key];
    for (const e of expired) {
      const text = `Seuil ${e.key} (${key === MAC_KEY ? 'tout le Mac' : 'ce projet'}) revenu à ${e.to ? `${e.to.soft ?? '–'} / ${e.to.hard ?? '–'} %` : 'la valeur au-dessus'}\nfin du ${e.from.soft ?? '–'} / ${e.from.hard ?? '–'} % prévu jusqu'au ${e.until}`;
      for (const project of where) pilotRecord({ project, kind: 'note', text });
      console.log('limits', key, 'until', e.key, e.until);
    }
    notify('settings');
  }
};
const limitsOf = (project) => { try { sweepLimits(); } catch (e) { console.error('limits until', e); } const rows = project ? limitRowsNow(project) : []; return { defaults: limits.DEFAULTS, mac: macLimits(), project: project ? storedSettings(project).limits || {} : null, effective: thresholdsOf(project), rows, share: project ? { max: shareMaxOf(project), soft: limits.SHARE_SOFT, row: rows.find((r) => r.id === 'share') || null } : null }; };
const saveLimits = (b) => {
  if (b.share !== undefined) {
    const key = projectArg(b.project); if (!key) throw new Error('share : un projet');
    const { value, errors } = limits.validateShare(b.share); if (errors) throw new Error(errors.join(' ; '));
    const st = storedSettings(key); if (value == null) delete st.share; else st.share = value;
    db.prepare('insert into project_settings (project, json, at) values (?, ?, ?) on conflict(project) do update set json = excluded.json, at = excluded.at').run(key, JSON.stringify(st), now());
    setImmediate(limitsTick); notify('settings');
    return { ok: true, ...limitsOf(key) };
  }
  const key = b.scope === 'mac' ? MAC_KEY : projectArg(b.project);
  const { value, errors } = limits.validateThresholds(b.limits); if (errors) throw new Error(errors.join(' ; '));
  // key by key: a weekly sent alone keeps model and the rest; null clears one key, limits: null all of them
  const st = storedSettings(key); const merged = b.limits === null ? {} : limits.mergeThresholds(st.limits, b.limits, value);
  if (!Object.keys(merged).length) delete st.limits; else st.limits = merged;
  db.prepare('insert into project_settings (project, json, at) values (?, ?, ?) on conflict(project) do update set json = excluded.json, at = excluded.at').run(key, JSON.stringify(st), now());
  setImmediate(limitsTick); notify('settings');
  return { ok: true, ...limitsOf(key === MAC_KEY ? (b.project ? projectArg(b.project) : null) : key) };
};
const learningSectionOf = (project) => { try { return learning.learningSection(project, learnedOf(project)); } catch { return ''; } };
// The distillation (docs/learning.md): one short Sonnet session, capped at one dollar, at most once a week per project and
// only once enough new results exist (lib/learning.mjs says the thresholds). One at a time; ESCADRILLE_LEARNING=off stops it.
// A server on another base (the tests, a branch seen on a copy of the developer's base) never distils unless
// ESCADRILLE_LEARNING=on: it would spend his dollars and write into his projects.
const DISTILL_ON = vars.LEARNING === 'on' || (vars.LEARNING !== 'off' && !vars.DB && !process.env.SM_DB);
const distilling = new Set();
const DISTILL_TICK_MS = 3600e3;
const distillTick = async () => {
  if (!DISTILL_ON || distilling.size) return;
  for (const { path: project } of knownProjects()) {
    learnedCache.delete(project);
    const registry = learnedOf(project); if (!registry) continue;
    if (!learning.distillDue({ registry, state: learning.stateOf(project) }).due) continue;
    distilling.add(project);
    try { const r = await learning.distill({ db, project, registry, start: startPlanner }); console.log(`learning: ${project} ${r.ok ? `${r.lines.length} lignes` : r.error} (${(r.cost || 0).toFixed(2)} $)`); }
    catch (e) { console.error('learning', e); }
    finally { distilling.delete(project); }
    return; // one project per tick
  }
};
setTimeout(() => distillTick().catch((e) => console.error('learning', e)), 120e3).unref();
setInterval(() => distillTick().catch((e) => console.error('learning', e)), DISTILL_TICK_MS).unref();
const limitsSectionOf = (project) => { try { return project ? limits.marginsSection(limitRowsNow(project)) : ''; } catch { return ''; } };

// ---------------------------------------------------------------- the burst « Jusqu'à la limite » (docs/burst.md)
// One task after the other: an escadrille whose questions get « ok pour tout », whose plan is made autonomous and
// launched; a hard stop at the dollar cap or on Stop, a drain near the limit. It never answers a stop or merges.
const BURST_TICK_MS = num(vars.BURST_TICK_MS, 15000);
const AUTO_TICK_MS = num(vars.AUTO_TICK_MS, 5 * 60e3);
const BURST_CUTOFF = vars.BURST_UNTIL || null; // an optional deadline (local time); else the quota horizon alone
const BURST_HUMAN_WAIT_MS = num(vars.BURST_HUMAN_WAIT_MS, burst.HUMAN_WAIT_MS);
const burstAnswer = new Set(); // planners of a burst whose questions are answered at the end of their turn
const burstOfEsc = new Map(); // escadrille id -> { burst, n }
const burstTaskOfEsc = (escId) => {
  if (burstOfEsc.has(escId)) return burstOfEsc.get(escId);
  for (const b of burst.burstsOf(db, null)) { const t = b.tasks.find((x) => x.escadrille === escId); if (t) { const v = { burst: b.id, n: t.n }; burstOfEsc.set(escId, v); return v; } }
  burstOfEsc.set(escId, null); return null;
};
// The value of a point, as GET /api/usage computes it; ESCADRILLE_DOLLARS_PER_PCT gives one to a trial without transcripts
const calibrationNow = () => { const f = num(vars.DOLLARS_PER_PCT, null); if (f) return { dollarsPerPct: f }; try { return calibrate({ db, sessions: transcriptsNow() }); } catch { return null; } };
const horizonNow = (project) => horizonOf({ db, project, calibration: calibrationNow() });
const statesOf = (planId) => { try { return stateOf(planId); } catch { return []; } };
// The status panel (lib/status.mjs): the limits measured by one Haiku call at most every 10 minutes, only while a client reads
const statusMeasurer = status.createMeasurer({ measure: () => status.measureAll({ env: safeEnv(process.env) }), onChange: () => { setImmediate(limitsTick); for (const k of new Set([...clients.values()].filter((k) => String(k).startsWith('project:')))) emitTo(k, 'change', Date.now()); } });
// docs/perf.md: the review queue runs git for every unmerged session; it is read again only when what it depends on moved
// (lib/memo.mjs reviewStamp, read without git) or after a minute, never on each refresh of each tab
const reviewsNow = (pf) => memo('reviews:' + pf, reviewStamp(db, pf), 60e3, () => review.reviewQueue(pf));
// The flow and the transcripts, computed once per state (a notify) and shared by /api/projectflow and /api/status
// « Retirés » also lists the plans moved by hand to plans/retired/ (6 November: ten Harbor plans, gone from the table plans)
const retiredFilesOf = (pf) => { const dir = path.join(PLANS_DIR, 'retired'); if (!existsSync(dir)) return []; const out = []; for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) { try { const p = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); if (p?.id && path.resolve(String(p.project || p.sessions?.[0]?.path || '')) === pf) out.push({ id: p.id, title: p.title || p.id, sessions: (p.sessions || []).length, cost: null, closedAt: p.closedAt || null, closedWhy: p.closedWhy || '', archived: true }); } catch {} } return out; };
const withRetiredFiles = (pf, f) => { const known = new Set(f.retired.map((p) => p.id)); return { ...f, retired: [...f.retired, ...retiredFilesOf(pf).filter((p) => !known.has(p.id))] }; };
const flowNow = (pf, all = false) => memo(`flow:${pf}:${all}`, changes, 5e3, () => { let calibration = null; try { calibration = estimateOf({ sessions: [] })?.calibration ?? null; } catch {} return { ...withRetiredFiles(pf, flowOf(db, pf, { all, defaultBudget: DEFAULT_BUDGET_USD, calibration, pilot: pilotPresent(pf), mode: (storedSettings(pf).autonomy || {}).mode })), qa: projectQaOf(pf) }; });
const transcriptsNow = () => memo('transcripts', 0, 10e3, () => scanTranscripts({ db }));
const statusNow = (project) => {
  const plans = plansList(project).map((pr) => { const p = planOf(pr.id) || {}; return { id: pr.id, title: pr.title, created: pr.created, network: p.network, autoMerge: p.autoMerge, capUsd: p.sessions ? planCapOf(p) : null, state: statesOf(pr.id) }; });
  let flow = { nodes: [], plans: [] }; try { flow = flowNow(project); } catch {}
  for (const p of plans) p.status = flow.plans.find((x) => x.id === p.id)?.status || (p.state.length ? 'running' : 'todo');
  let sessions = []; try { sessions = transcriptsNow(); } catch {}
  const m = statusMeasurer.read();
  return { ...status.statusOf({ project, sessions, quota: quotaNow(), measure: { ...m, last: newestWindows(m.last) }, thresholds: thresholdsOf(project), share: shareOf(project, status.limitsOf({ quota: quotaNow(), measured: newestWindows(m.last) })), nodes: flow.nodes, plans, autonomy: projectAutonomyOf(project), network: projectNetwork(project), burst: burst.burstsOf(db, project)[0] || null, dollarsPerPct: calibrationNow()?.dollarsPerPct ?? null }), pilot: { present: pilotPresent(project), external: presence.external(project) } };
};
const taskCost = (t) => (t.escadrille ? escadrilleOf(t.escadrille)?.usage?.cost || 0 : 0) + (t.plan ? statesOf(t.plan).reduce((a, r) => a + (r.usage?.cost || 0), 0) : 0);
const burstSpent = (b) => Math.round(b.tasks.reduce((a, t) => a + taskCost(t), 0) * 100) / 100;
const burstSave = (b) => { burst.saveBurst(db, b); notify('burst:' + b.id); notify('bursts'); return b; };
const burstSectionOf = (escId) => { const k = burstTaskOfEsc(escId); const b = k && burst.burstOf(db, k.burst); return b ? burst.plannerSection(Math.max(0, b.capUsd - burstSpent(b))) : ''; };
const burstShape = (k, plan) => { const b = burst.burstOf(db, k.burst); const st = storedSettings(b.project); return burst.shapePlan(plan, { rest: Math.max(0.01, b.capUsd - burstSpent(b)), projectAutonomy: projectAutonomyOf(b.project), defaultBudget: st.budget ?? DEFAULT_BUDGET_USD }); };
const burstAnswerQuestions = (escId) => {
  try { sendMessage(escId, burst.answerFor(escadrilleOf(escId))); } catch (e) { console.error('burst answer', e); return; }
  const k = burstTaskOfEsc(escId); const b = k && burst.burstOf(db, k.burst); if (b) burstSave(burst.logLine(b, `Tâche ${k.n} : questions acceptées`));
};
const burstPlanWritten = (k, planId) => {
  const b = burst.burstOf(db, k.burst); const t = b?.tasks.find((x) => x.n === k.n); if (!t || t.status !== 'planning') return;
  t.plan = planId;
  if (b.status !== 'running') { t.status = 'todo'; burstSave(burst.logLine(b, `Tâche ${t.n} : plan écrit, pas lancé (vidange)`)); return; }
  t.status = 'running'; burstSave(burst.logLine(b, `Tâche ${t.n} : plan lancé`));
  launchPlan(planId).catch((e) => { const x = burst.burstOf(db, b.id); burstSave(burst.logLine(x, `Tâche ${t.n} : lancement impossible, ${e.message}`)); });
};
const burstPush = (b, kind, text) => {
  const to = push.recipients(deviceRows(), { tokenDays: TOKEN_DAYS }); if (!to.length) return;
  const messages = push.messagesFor(to, { title: push.titleFor(projectName(b.project), push.noticeText(kind, { text: i18n.plain(text) })), body: i18n.plain(text), plan: null, session: null, kind, id: b.id }); // the phone reads French, never a marker
  push.pushMessages(PUSH_URL, messages).catch((e) => console.error(`push: ${e.message} (${kind}, ${b.id})`));
};
const hhmm = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const burstStartTask = (b, t) => {
  t.status = 'planning'; t.started = now();
  try { const { id } = createEscadrille({ project: b.project, idea: t.text, model: b.model }, { burst: { burst: b.id, n: t.n } }); t.escadrille = id; burst.logLine(b, `Tâche ${t.n} : planification`); }
  catch (e) { t.status = 'failed'; t.ended = now(); burst.logLine(b, `Tâche ${t.n} : échec, ${e.message}`); }
};
// The end: 'done' after a drain or the last task, 'limit' at the cap, 'stopped' on Stop and 'ended' at until stop the
// processes. A session stopped here leaves the page (mode null): a restart of the server never resumes it; 'ended'
// stops every session of its plans, a finished task's too (until is the end, without exception)
const burstStopRows = (planId, line) => { for (const r of statesOf(planId)) if (procOf(planId, r.id) || r.mode === 'page' || r.status === 'paused') { try { sessionStop(planId, r.id); if (line) addSessionMessage(planId, r.id, 'system', line); } catch {} } };
const burstEnd = (b, status, why) => {
  b.status = status; burst.logLine(b, why);
  const line = status === 'ended' ? msg('srv.b.sessionEnded', { t: hhmm(b.until) }) : null;
  if (status !== 'done') for (const t of b.tasks) {
    if (t.status === 'planning') { const p = planners.get(t.escadrille); if (p && !p.exited) p.stop(); if (status === 'ended' && escadrilleOf(t.escadrille)?.status === 'thinking') setEscadrille(t.escadrille, { status: 'stopped' }); t.status = 'todo'; t.note = 'arrêtée'; }
    if (t.status === 'running') { burstStopRows(t.plan, line); t.status = 'todo'; t.note = 'arrêtée, reprenable à la main'; }
    else if (status === 'ended' && t.plan) burstStopRows(t.plan, line);
  }
  const done = b.tasks.filter((t) => t.status === 'done').length;
  burstPush(b, 'burst-end', msg('srv.b.end', { how: msg(status === 'done' ? 'srv.b.finished' : status === 'limit' ? 'srv.b.atCap' : status === 'ended' ? 'srv.b.atEnd' : 'srv.b.stopped'), done, n: b.tasks.length, spent: usd(b.spentUsd) }));
  return burstSave(b);
};
const burstStep = async (id) => {
  const b = burst.burstOf(db, id); if (!b || !burst.ACTIVE.includes(b.status)) return;
  for (const t of b.tasks) t.cost = Math.round(taskCost(t) * 100) / 100;
  b.spentUsd = burstSpent(b);
  if (burst.pastUntil(b)) return burstEnd(b, 'ended', msg('srv.b.endTime', { t: hhmm(b.until) })); // until is the end, drain or not
  if (b.spentUsd >= b.capUsd) return burstEnd(b, 'limit', `Plafond atteint : ${usd(b.spentUsd)} sur ${usd(b.capUsd)}`);
  // The thresholds (docs/limits.md): the hard one ends the burst and stops its work, the soft one drains it
  // A window that resets pauses the sessions (pauseAllFor) and drains the burst: its task resumes at the reset and ends
  const lrows = limitRowsNow(b.project, { burst: b }); const lv = limits.verdictOf(lrows);
  if (lv.level === 'hard') {
    const cap = lrows.find((r) => r.level === 'hard' && !limits.pausable(r));
    if (cap) { const line = limits.verdictOf([cap]).line; stopAllFor(b.project, line, null, cap); return burstEnd(burst.burstOf(db, b.id) || b, 'limit', line); }
    for (const win of limits.hardPausable(lrows, (r) => isForced(b.project, r))) pauseAllFor(b.project, win, limits.verdictOf([win]).line);
  }
  if (lv.level !== 'ok' && b.status === 'running') { b.status = 'draining'; burst.logLine(b, msg('lim.drain', { line: lv.line })); }
  const cur = b.tasks.find((t) => t.status === 'planning' || t.status === 'running');
  const close = (t, status, why) => { t.status = status; t.ended = now(); burst.logLine(b, `Tâche ${t.n} : ${why}`); };
  if (cur?.status === 'planning') {
    const e = escadrilleOf(cur.escadrille);
    if (!e || e.status === 'error' || e.status === 'stopped') close(cur, 'failed', 'la planification a échoué');
    else if (e.status === 'waiting' && !e.plan_id && !burstAnswer.has(e.id)) {
      if (!cur.nudged) { cur.nudged = true; try { sendMessage(e.id, 'Écris le plan.'); } catch {} } else close(cur, 'failed', 'pas de plan écrit');
    }
  } else if (cur?.status === 'running') {
    const rows = statesOf(cur.plan);
    if (planFinished(cur.plan)) close(cur, 'done', 'plan fini');
    else if (rows.length && rows.every((r) => r.status === 'done') && Date.now() - Math.max(...rows.map((r) => Date.parse(r.at) || 0)) > BURST_HUMAN_WAIT_MS) close(cur, 'done', 'fini, attend un humain');
  }
  if (b.status === 'running' && burst.shouldDrain(b)) { b.status = 'draining'; burst.logLine(b, 'Vidange : plus de nouvelle tâche, le travail en cours se livre'); }
  const busy = b.tasks.find((t) => t.status === 'planning' || t.status === 'running');
  if (b.status === 'draining') {
    if (!busy) return burstEnd(b, 'done', 'Rafale finie (vidange)');
    if (busy.status === 'running') for (const r of statesOf(busy.plan)) {
      if (r.status !== 'waiting' || !r.pending.some((p) => p.kind === 'reply') || (busy.finished || []).includes(r.id)) continue;
      try { sessionMessage(busy.plan, r.id, burst.FINISH_TEXT); busy.finished = [...(busy.finished || []), r.id]; burst.logLine(b, `Tâche ${busy.n}, ${r.id} : « ${burst.FINISH_TEXT} »`); } catch {}
    }
    return burstSave(b);
  }
  if (!busy) {
    let q = []; try { const r = await review.reviewQueue(b.project); q = Array.isArray(r) ? r : r?.reviews || []; } catch {}
    const min = burst.reviewMinutes(q);
    if (min > burst.REVIEW_MAX_MIN) { const w = `En attente : ${Math.round(min / 60)} h de revue en file`; if (b.log[b.log.length - 1]?.text !== w) burst.logLine(b, w); return burstSave(b); }
    const next = b.tasks.find((t) => t.status === 'todo' && !t.note);
    if (!next) return burstEnd(b, 'done', 'Rafale finie : toutes les tâches passées');
    burstStartTask(b, next);
  }
  return burstSave(b);
};
// At the start of the server and at each tick, before anything else: every active burst whose until is past ends
const burstExpire = () => {
  for (const b of burst.activeBursts(db)) { if (!burst.pastUntil(b)) continue;
    try { for (const t of b.tasks) t.cost = Math.round(taskCost(t) * 100) / 100; b.spentUsd = burstSpent(b); burstEnd(b, 'ended', msg('srv.b.endTime', { t: hhmm(b.until) })); } catch (e) { console.error('burst expire', e); } }
};
const burstTick = async () => {
  burstExpire();
  limitsTick();
  for (const b of burst.activeBursts(db)) { try { await burstStep(b.id); } catch (e) { console.error('burst', e); } }
  burst.setDraining(burst.activeBursts(db).filter((b) => b.status === 'draining').flatMap((b) => b.tasks.map((t) => t.plan).filter(Boolean)));
};
// The backlog page (docs/backlog-page.md, lib/backlog.mjs): the file is the truth, every edit names its line and its text
const backlogFileOf = (project) => path.join(project, burst.BACKLOG);
const backlogText = (project) => { const f = backlogFileOf(project); return existsSync(f) ? readFileSync(f, 'utf8') : null; };
const plansInProgress = (project) => plansList(project).map((pr) => planOf(pr.id)).filter((p) => p && !isRetired(p) && !isFinished(p, statesOf(p.id)));
const backlogDoc = (project) => {
  const text = backlogText(project); const file = backlogFileOf(project);
  if (text == null) return { exists: false, file, sections: [], items: [], plans: [] };
  const doc = backlogmod.parseDoc(text);
  return { exists: true, file, ...doc, plans: plansInProgress(project).map((p) => ({ id: p.id, title: p.title })) };
};
const backlogEdit = (project, b) => {
  const text = backlogText(project); if (text == null) throw Object.assign(new Error('pas de docs/backlog.md'), { code: 404 });
  const next = b.op === 'toggle' ? backlogmod.toggle(text, b.line, b.md) : b.op === 'add' ? backlogmod.add(text, b.text) : b.op === 'move' ? backlogmod.move(text, b.line, b.dir, b.md) : null;
  if (next == null) throw Object.assign(new Error("op : 'toggle', 'add' ou 'move'"), { code: 400 });
  if (next !== text) writeFileSync(backlogFileOf(project), next);
  return backlogDoc(project);
};
const retiredJsonOf = (link) => { if (!link) return null; try { return JSON.parse(readFileSync(path.join(PLANS_DIR, 'retired', path.basename(link)), 'utf8')); } catch { return null; } };
const backlogNearest = (project, line) => {
  const doc = backlogmod.parseDoc(backlogText(project) || ''); const it = doc.items.find((x) => x.line === Number(line));
  if (!it) throw Object.assign(new Error('ligne introuvable'), { code: 404 });
  return { line: it.line, text: it.text, plans: backlogmod.nearestPlans(it, plansInProgress(project), doc.sections[it.section]?.text || '') };
};
// « Ajouter à un plan »: one session more, in the wave after the launched ones; a launched session never changes (planRefusals)
const backlogAttach = (project, b) => {
  const text = backlogText(project); if (text == null) throw Object.assign(new Error('pas de docs/backlog.md'), { code: 404 });
  const doc = backlogmod.parseDoc(text); const it = doc.items.find((x) => x.line === Number(b.line));
  if (!it || (b.md != null && it.md !== b.md)) throw Object.assign(new Error('le backlog a changé : recharge la page'), { code: 409 });
  if (it.attached) throw Object.assign(new Error(`déjà rattachée : session ${it.attached.session} du plan ${it.attached.plan}`), { code: 409 });
  const plan = planOf(String(b.plan || '')); if (!plan || isRetired(plan)) throw Object.assign(new Error('plan introuvable ou retiré'), { code: 404 });
  const { session, next } = backlogmod.sessionFor(plan, statesOf(plan.id), it, { retired: retiredJsonOf(it.link), sectionText: doc.sections[it.section]?.text || '', budget: DEFAULT_BUDGET_USD });
  const { plan: valid, errors } = validatePlan(next, { project: plan.project }); if (errors) throw Object.assign(new Error(errors.join(' ; ')), { code: 400 });
  const refused = planRefusals(valid); if (refused.length) throw Object.assign(new Error('plan déjà lancé : ' + refused.join(' ; ')), { code: 409 });
  writePlan(valid); notify('plan:' + plan.id);
  writeFileSync(backlogFileOf(project), backlogmod.attach(text, it.line, it.md, { plan: plan.id, session: session.id }));
  return { ok: true, plan: plan.id, session: session.id, wave: session.wave, ...backlogDoc(project) };
};
// At the merge of a session, its backlog line checks itself
const backlogTick = (project, planId, sid) => { try { const text = backlogText(project); if (text == null) return; const next = backlogmod.tickAttached(text, planId, sid); if (next !== text) writeFileSync(backlogFileOf(project), next); } catch (e) { console.error('backlog', e.message); } };
const startBurst = (b0) => {
  const project = projectArg(b0.project);
  if (burst.activeBursts(db).some((x) => x.project === project)) { const e = new Error(msg('srv.e.burstRunning')); e.code = 409; throw e; }
  const backlog = burst.readBacklog(project); if (!backlog.exists) throw new Error('pas de docs/backlog.md');
  const wanted = Array.isArray(b0.tasks) ? b0.tasks.map(Number) : backlog.tasks.filter((t) => !t.done).map((t) => t.n);
  const tasks = backlog.tasks.filter((t) => wanted.includes(t.n) && !t.done).map((t) => ({ n: t.n, text: t.text, status: 'todo', escadrille: null, plan: null, cost: 0 }));
  if (!tasks.length) throw new Error(msg('srv.e.noTask'));
  const capUsd = Number(b0.capUsd); if (!(capUsd > 0)) throw new Error('capUsd : un nombre de dollars > 0');
  if (b0.model && !isModel(String(b0.model))) throw new Error(`modèle inconnu ${b0.model}`);
  { const lv = limits.verdictOf(limitRowsNow(project)); if (lv.level !== 'ok') throw new Error(i18n.plain(lv.line)); }
  const model = b0.model ? String(b0.model) : storedSettings(project).model || 'claude-opus-5-5';
  // « Avancer le backlog jusqu'à 18 h » (docs/burst.md): the hour asked, else the server's cutoff; the earlier of it and the limit
  if (b0.until !== undefined && !(Date.parse(b0.until) > Date.now())) throw new Error('until : une heure à venir');
  const until = burst.untilOf({ resetsAt: horizonNow(project).resetsAt, cutoff: b0.until ?? BURST_CUTOFF });
  const drainMin = b0.drainMin !== undefined ? Number(b0.drainMin) : burst.DRAIN_MIN; if (!(drainMin >= 0)) throw new Error('drainMin : des minutes ≥ 0');
  const b = { id: 'burst-' + Date.now().toString(36) + randomBytes(2).toString('hex'), project, created: now(), status: 'running', capUsd, spentUsd: 0, until, drainAt: burst.drainAtOf(until, drainMin), model, tasks, log: [] };
  const text = msg('srv.b.launched', { n: tasks.length, cap: `${Math.round(capUsd)} $`, t: hhmm(until) });
  burst.logLine(b, b0.auto ? 'Mode auto : ' + text : text);
  burst.insertBurst(db, b); burstPush(b, 'burst-start', text);
  setImmediate(() => burstTick().catch((e) => console.error('burst', e)));
  return { id: b.id };
};
const burstStop = (id) => { const b = burst.burstOf(db, id); if (!b) throw new Error('rafale inconnue'); if (['running', 'draining'].includes(b.status)) { b.spentUsd = burstSpent(b); burstEnd(b, 'stopped', 'Stop'); } return { ok: true }; };
// The auto mode: each project with autoBurst.on, no burst running, the margin above minMarginPct, the limit within maxHoursLeft
const autoTick = () => {
  for (const { project, json: j } of db.prepare('select project, json from project_settings').all()) {
    const auto = parse(j, {}).autoBurst; if (!auto?.on || burst.activeBursts(db).some((b) => b.project === project)) continue;
    const h = horizonNow(project); if (!burst.autoWants(auto, h)) continue;
    const todo = burst.readBacklog(project).tasks.filter((t) => !t.done); if (!todo.length) continue;
    try { startBurst({ project, tasks: todo.map((t) => t.n), capUsd: burst.defaultCap(h), auto: true }); } catch (e) { console.error('auto burst', e.message); }
  }
};
setInterval(() => burstTick().catch((e) => console.error('burst', e)), BURST_TICK_MS).unref();
setInterval(autoTick, AUTO_TICK_MS).unref();

// ---------------------------------------------------------------- Phase 16 GH (docs/connectors.md): the PRs, the relay, the merge on a click
const ghSessionsOf = (project) => db.prepare('select s.plan, s.id, s.status, s.mode, s.pr, s.worktree from sessions s join plans p on p.id = s.plan where p.project = ?').all(project)
  .map((r) => { const w = parse(r.worktree) || {}; return { planId: r.plan, sessionId: r.id, status: r.status, mode: r.mode, pr: parse(r.pr), branch: w.branch || null, base: w.base || null, path: w.path || null, merged: !!w.merged }; });
const ghSecretsOf = (project) => { const out = []; const walk = (v) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(envAccountsOf(project)); for (const k of ['linear', 'team']) walk(secrets.get(project, k)); return out.filter((s) => s.length >= 6); };
const ghCtx = {
  json, readBody, projectArg, sessionsOf: ghSessionsOf, secretsOf: ghSecretsOf, record: pilotRecord,
  guardOk: (req) => guardrails.keyMatches(guardrails.keyFromCookie(req.headers.cookie), GUARD_KEY),
  say: (planId, sid, text) => addSessionMessage(planId, sid, 'system', text),
};
const ghDeliver = (l, entry, route) => {
  const first = `PR #${entry.pr.number} : ${entry.causes.length} cause${entry.causes.length > 1 ? 's' : ''} relayée${entry.causes.length > 1 ? 's' : ''}`;
  if (route === 'toYou') {
    const row = rowOf(l.planId, l.sessionId); if (!row) return;
    const item = { id: fid('github'), kind: 'github', text: `PR #${entry.pr.number} : à corriger, la session est close`, url: entry.pr.url, entry, at: now() };
    setPending(l.planId, l.sessionId, [...row.pending, item]); pushNotice(l.planId, l.sessionId, 'waiting', item.id, {});
    pilotRecord({ project: l.project, planId: l.planId, sessionId: l.sessionId, kind: 'note', text: first + ' vers « À toi »\n' + entry.causes.join(', ') });
    return;
  }
  try { sessionMessage(l.planId, l.sessionId, entry.text, { reviewComment: entry }); pilotRecord({ project: l.project, planId: l.planId, sessionId: l.sessionId, kind: 'message', text: first + (route === 'reopen' ? ' (session rouverte)' : '') + '\n' + entry.causes.join(', ') }); }
  catch (e) { addSessionMessage(l.planId, l.sessionId, 'system', 'Relais GitHub impossible : ' + e.message); }
};
const ghLinks = () => {
  const out = [];
  for (const { project } of db.prepare('select distinct project from plans where project is not null').all()) {
    for (const s of ghSessionsOf(project)) {
      if (!Number(s.pr?.number)) continue;
      out.push({ project, cwd: s.path && existsSync(s.path) ? s.path : project, planId: s.planId, sessionId: s.sessionId, number: Number(s.pr.number), base: s.pr.base || s.base, branch: s.pr.head || s.branch, status: s.status, mode: s.mode, merged: s.merged, planDone: planFinished(s.planId), canReopen: s.status !== 'done' || !!(s.path && existsSync(s.path)) });
    }
  }
  return out;
};
let ghBusy = false;
const ghTick = async () => {
  if (ghBusy || !github.ghPresent()) return; ghBusy = true;
  try { const links = ghLinks(); if (links.length) await ghrelay.relayTick({ db, links, gh: github, deliver: ghDeliver, secretsOf: ghSecretsOf, onError: (l, e) => console.error('ghrelay', l.project, l.number, e.message) }); }
  finally { ghBusy = false; }
};
setInterval(() => ghTick().catch((e) => console.error('ghrelay', e)), num(vars.GH_TICK_MS, 30e3)).unref();

// ---------------------------------------------------------------- the architecture map (docs/architecture.md)
// ?project=&ref= | ?project=&base=&head= | ?plan=&session= (the session's branch against its common base with the repo's current branch)
const archTarget = async (url) => {
  const q = (k) => String(url.searchParams.get(k) || '').trim();
  if (q('plan')) {
    const row = rowOf(q('plan'), q('session')); if (!row) throw new Error('session inconnue');
    const wt = row.worktree; if (!wt?.root || !wt.branch) throw new Error('cette session n’a pas de worktree');
    return { repo: wt.root, base: 'HEAD', head: wt.branch };
  }
  return { repo: projectArg(q('project')), base: q('base') || null, head: q('head') || q('ref') || 'HEAD' };
};

// ---------------------------------------------------------------- http
const PUBLIC = path.join(HERE, 'public');
const demo = createDemo({ root: vars.DEMO_ROOT || HERE, ttlMs: num(vars.DEMO_TTL_MS, undefined), onChange: () => notify('demo') });
// FILE (docs/replies.md): the queue of the comments on the launch posts. No source yet (ESS adds one per platform): the
// page stays empty; « Envoyer » only hands the text to the paste step, nothing leaves the Mac without Dev's click
const repliesStore = replies.createStore(db);
const repliesSources = [];
setInterval(() => { if (repliesSources.length) replies.tick(repliesStore, repliesSources, { root: HERE, runSmall }).catch(() => {}); }, 60000).unref();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const seg = url.pathname.split('/').filter(Boolean);
  res.req = req;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); return res.end(); }
    // The guard (docs/phone.md): from the LAN, pairing is open, everything else needs a device token, and a token opens the phone's routes only
    // A poste (docs/studio.md) pairs from its browser: its token goes into an HttpOnly cookie, never into the body
    const pairRoute = async () => { try {
      if (pairing?.kind === 'poste' && !mac && !poste.originOk(req)) return json(res, 403, { error: 'origine refusée' });
      const r = pair(await readBody(req)); if (r.device.kind !== 'poste') return json(res, 200, r);
      res.setHeader('set-cookie', poste.setCookie(r.token)); return json(res, 200, { device: r.device });
    } catch (e) { return json(res, e.status || 400, { error: e.message }); } };
    const mac = isLoopback(req); let device = null;
    if (url.pathname === '/pair' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(poste.pairPage(req.headers.host)); }
    if (!mac) {
      if (url.pathname === '/api/pair' && req.method === 'POST') return pairRoute();
      device = deviceOf(bearerOf(req, url) || poste.cookieToken(req.headers.cookie));
      if (!device) { // a browser asking a page gets the pairing page itself, still a 401
        if (req.method === 'GET' && seg[0] !== 'api' && /text\/html/.test(req.headers.accept || '')) { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(poste.pairPage(req.headers.host)); }
        return json(res, 401, { error: 'appairage requis' });
      }
      if (device.kind === 'poste') {
        if (!poste.originOk(req)) return json(res, 403, { error: 'origine refusée' });
        if (poste.studioOnly(seg, req.method)) return json(res, 403, { error: 'sur le Studio seulement' });
      } else if (!PHONE_ROUTES(seg, req.method)) return json(res, 403, { error: 'depuis le Mac seulement' });
    }
    // The gate (docs/gate.md, lib/gate.mjs): a route that acts needs the developer's guard cookie, a paired device or the pilot's
    // token; a session calling from 127.0.0.1 has none of them. One table, before the routes; the handlers' own checks stay.
    const row = gate.classify(req.method, url.pathname);
    if (row.kind === 'act' && !GATE_OFF) {
      const proofs = {
        cookie: guardrails.keyMatches(guardrails.keyFromCookie(req.headers.cookie), GUARD_KEY),
        device: !!(device || deviceOf(bearerOf(req, url) || poste.cookieToken(req.headers.cookie))),
        pilot: gate.tokenMatches(req.headers[gate.PILOT_HEADER], PILOT_TOKEN),
      };
      if (!gate.opened(row, proofs)) {
        const r = gate.refusal(row, req.method, url.pathname, { guardLinkFile: path.join(guardrails.dirOf(), 'guard-link') });
        return json(res, 403, { error: msg(r.messageKey, r.vars.gesture ? { gesture: msg(r.vars.gesture) } : r.vars), gate: r.gate });
      }
    }
    if (url.pathname === '/api/whoami' && req.method === 'GET') return json(res, 200, { mac, poste: device?.kind === 'poste' ? { id: device.id, name: device.name } : null, host: hostname().replace(/\.local$/, ''), address: lanAddress() });
    if (url.pathname === '/api/pair' && req.method === 'POST') return pairRoute();
    if (url.pathname === '/api/pair/code' && req.method === 'POST') return json(res, 200, newCode((await readBody(req).catch(() => ({})))?.kind));
    // The link of ~/.config/escadrille/guard-link (docs/autonomy.md): the browser keeps the key that approves a touched guardrail
    if (url.pathname === '/guard' && req.method === 'GET') { if (!guardrails.keyMatches(url.searchParams.get('k'), GUARD_KEY)) return json(res, 403, { error: 'clé refusée' }); res.writeHead(303, { 'set-cookie': guardrails.guardCookie(GUARD_KEY), location: '/', 'cache-control': 'no-store' }); return res.end(); }
    if (seg[0] === 'api' && seg[1] === 'phone') {
      if (!device) device = deviceOf(bearerOf(req, url)); if (!device) return json(res, 401, { error: 'appairage requis' });
      if (!seg[2] && req.method === 'GET') return json(res, 200, phoneHome(device, projectFilter(url)));
      if (seg[2] === 'push-token' && req.method === 'POST') return json(res, 200, setPushToken(device.id, (await readBody(req)).expoPushToken));
      if (seg[2] === 'forget' && req.method === 'POST') { if (device.kind === 'poste') res.setHeader('set-cookie', poste.setCookie(null)); return json(res, 200, forgetDevice(device.id)); }
      return json(res, 404, { error: 'not found' });
    }
    if (seg[0] === 'api' && seg[1] === 'docker') return dock.handle(req, res, url, { guardKey: guardrails.keyFromCookie(req.headers.cookie) }); // docs/docker.md: the guard cookie, 403 without
    if (url.pathname === '/api/devices' && req.method === 'GET') return json(res, 200, devicesList());
    if (seg[0] === 'api' && seg[1] === 'devices' && seg[2] && seg[3] === 'forget' && req.method === 'POST') { try { return json(res, 200, forgetDevice(decodeURIComponent(seg[2]))); } catch (e) { return json(res, e.status || 400, { error: e.message }); } }
    // The registry (phase 11 S): add a folder (validated here), take one out of the list (nothing deleted), suggest, complete
    if (url.pathname === '/api/projects' && req.method === 'POST') { try { const r = registry.add((await readBody(req)).path, { via: 'app', file: PROJECTS_FILE }); if (r.added) firstSettings(r.path); notify('projects'); return json(res, 200, { ok: true, path: r.path, added: r.added, ...projectsAnswer() }); } catch (e) { return json(res, e.status || 400, { error: e.message }); } }
    if (url.pathname === '/api/projects/remove' && req.method === 'POST') { const r = registry.remove((await readBody(req)).path, { file: PROJECTS_FILE }); notify('projects'); return json(res, 200, { ok: true, path: r.path, removed: r.removed, ...projectsAnswer() }); }
    // The displayed name of a project (docs/correctif-server-nom-projet.md, session NOM): empty falls back to the folder name
    if (url.pathname === '/api/projects/name' && req.method === 'POST') { try { const b = await readBody(req); const r = registry.setName(b.path, b.name, { file: PROJECTS_FILE }); notify('projects'); return json(res, 200, { ok: true, path: r.path, name: r.name, custom: r.custom, ...projectsAnswer() }); } catch (e) { return json(res, e.status || 400, { error: e.message }); } }
    if (url.pathname === '/api/projects/suggestions' && req.method === 'GET') { migrateRegistry(); return json(res, 200, { suggestions: registry.suggestions({ home: CLAUDE_HOME, file: PROJECTS_FILE }) }); }
    if (url.pathname === '/api/projects/dirs' && req.method === 'GET') return json(res, 200, { dirs: registry.completions(url.searchParams.get('prefix') || '', { home: CLAUDE_HOME }) });
    if (url.pathname === '/api/projects') return json(res, 200, projectsAnswer());
    if (url.pathname === '/api/models') return json(res, 200, { models: listModels({}) });
    if (url.pathname === '/api/project') return json(res, 200, await projectFacts(url.searchParams.get('path') || ''));
    if (url.pathname === '/api/escadrilles') { const pf = projectFilter(url); const t = Date.now(); return json(res, 200, db.prepare('select id, title, project, model, status, plan_id, created, at from escadrilles where (? is null or project = ?) order by at desc').all(pf, pf).map((e) => (isStalePlanning(e, t) ? { ...e, stale: true } : e))); }
    if (url.pathname === '/api/project/horizon' && req.method === 'GET') return json(res, 200, horizonNow(projectArg(url.searchParams.get('project'))));
    if (url.pathname === '/api/limits/resume' && req.method === 'POST') { try { return json(res, 200, resumeAll(projectArg((await readBody(req)).project))); } catch (e) { return json(res, 400, { error: e.message }); } }
    if (url.pathname === '/api/limits') { if (req.method === 'POST') { try { return json(res, 200, saveLimits(await readBody(req))); } catch (e) { return json(res, 400, { error: e.message }); } } return json(res, 200, limitsOf(projectFilter(url))); }
    if (url.pathname === '/api/status' && req.method === 'GET') { const pf = projectFilter(url); if (!pf) return json(res, 400, { error: 'project manquant' }); return json(res, 200, statusNow(pf)); }
    if (url.pathname === '/api/project/backlog/doc' && req.method === 'GET') return json(res, 200, backlogDoc(projectArg(url.searchParams.get('project'))));
    if (url.pathname === '/api/project/backlog/nearest' && req.method === 'GET') { try { return json(res, 200, backlogNearest(projectArg(url.searchParams.get('project')), url.searchParams.get('line'))); } catch (e) { return json(res, e.code || 400, { error: e.message }); } }
    if (url.pathname === '/api/project/backlog/edit' && req.method === 'POST') { const b = await readBody(req); try { return json(res, 200, backlogEdit(projectArg(b.project), b)); } catch (e) { return json(res, e.code || 400, { error: e.message }); } }
    if (url.pathname === '/api/project/backlog/attach' && req.method === 'POST') { const b = await readBody(req); try { return json(res, 200, backlogAttach(projectArg(b.project), b)); } catch (e) { return json(res, e.code || 400, { error: e.message }); } }
    if (url.pathname === '/api/project/backlog') { if (req.method !== 'POST') return json(res, 200, burst.readBacklog(projectArg(url.searchParams.get('project')))); const b = await readBody(req); const pr = projectArg(b.project); try { if (b.from === 'defect') return json(res, 200, burst.appendDefect(pr, { text: b.text, screen: b.screen })); return json(res, 200, burst.createBacklog(pr, { from: b.from, text: b.text, memoryFile: memoryFileOf(pr) })); } catch (e) { return json(res, e.code === 409 ? 409 : 400, { error: e.message }); } }
    if (url.pathname === '/api/burst' && req.method === 'POST') { try { return json(res, 200, startBurst(await readBody(req))); } catch (e) { return json(res, e.code === 409 ? 409 : 400, { error: e.message }); } }
    if (url.pathname === '/api/bursts' && req.method === 'GET') return json(res, 200, { bursts: burst.burstsOf(db, projectFilter(url)) });
    if (seg[0] === 'api' && seg[1] === 'burst' && seg[2]) { const id = decodeURIComponent(seg[2]); if (seg[3] === 'stop' && req.method === 'POST') return json(res, 200, burstStop(id)); const b = burst.burstOf(db, id); return b ? json(res, 200, b) : json(res, 404, { error: 'rafale inconnue' }); }
    // One line of the project's list: { project, host, scope? } adds it or changes its scope (no scope: its default),
    // { project, host, remove: true } takes it out (docs/access.md, « Domaines »)
    if (url.pathname === '/api/project/domain' && req.method === 'POST') {
      const b = await readBody(req); const project = projectArg(b.project); const host = String(b.host || '').trim().toLowerCase();
      const cur = projectNetwork(project); const line = b.scope ? { host, scope: b.scope } : host;
      // keep: « Autoriser pour le projet » never narrows a host already listed (both stays both)
      const next = b.remove ? cur.filter((e) => e.host !== host) : cur.some((e) => e.host === host) ? (b.keep ? cur : cur.map((e) => (e.host === host ? line : e))) : [...cur, line];
      try { return json(res, 200, writeSettings({ project, network: next })); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/project/settings') return json(res, 200, req.method === 'POST' ? writeSettings(await readBody(req), { guardKey: guardrails.keyFromCookie(req.headers.cookie) }) : settingsOf(projectArg(url.searchParams.get('project'))));
    if (url.pathname === '/api/architecture' && req.method === 'GET') { const t = await archTarget(url); return json(res, 200, await mapOf(t.repo, t.head)); }
    if (url.pathname === '/api/architecture/delta' && req.method === 'GET') { const t = await archTarget(url); if (!t.base) throw new Error('base et head sont requis'); return json(res, 200, await architectureDelta(t)); }
    if (url.pathname === '/api/game' && req.method === 'GET') { const pf = projectFilter(url); const st = pf ? storedSettings(pf) : {}; if (!game.gameOn(st)) return json(res, 200, { off: true }); const plan = url.searchParams.get('plan'); return json(res, 200, { ...game.levelOf(db, { project: pf, rulesFile: game.rulesFileOf(pf), defaultBudget: DEFAULT_BUDGET_USD, reviewLevel: st.review || review.DEFAULT_LEVEL }), plan: plan ? game.planXp(db, plan, { defaultBudget: DEFAULT_BUDGET_USD }) : null }); }
    if (url.pathname === '/api/asks' && req.method === 'GET') return json(res, 200, asksNow(projectFilter(url))); // « À toi », docs/asks.md
    if (url.pathname === '/api/access' && req.method === 'GET') return json(res, 200, accessOf(projectFilter(url)));
    if (url.pathname === '/api/projectflow' && req.method === 'GET') { const pf = projectFilter(url); if (!pf) return json(res, 400, { error: 'project manquant' }); return json(res, 200, { ...flowNow(pf, url.searchParams.get('all') === '1'), pilot: { present: pilotPresent(pf) }, pause: pauseSummaryOf(pf) }); }
    // the logo of a known project, read in its folder (lib/projectlogo.mjs), never a file outside it; 404 when none
    if (/^\/(comm|api\/comm(\/file)?)$/.test(url.pathname)) return await comm.route(req, res, url, { db, publicDir: PUBLIC, plansDir: PLANS_DIR, known: (p) => knownProjects().some((x) => x.path === p) });
    if (url.pathname === '/api/projects/logo' && req.method === 'GET') { const a = projectlogo.logoAnswer({ project: projectFilter(url), known: knownProjects().map((p) => p.path) }); if (a.status !== 200) { res.writeHead(204); return res.end(); } /* no logo or an unknown project: 204, the page keeps its initial, the console stays clean */ res.writeHead(200, { 'content-type': a.logo.type, 'cache-control': 'private, max-age=300' }); return res.end(readFileSync(a.logo.path)); }
    // Phase 8 A, the pilot of a project (docs/pilot.md): its switch, its caps
    if (url.pathname === '/api/pilot' && req.method === 'POST') { const b = await readBody(req);
      // an external pilot declares itself (and renews with each call); { external: false } withdraws it at once
      if (b.external !== undefined) { const project = projectArg(b.project); if (b.external) presence.touch(project); else presence.forget(project); notify('main:' + project); emitTo('project:' + project, 'change', Date.now()); return json(res, 200, { ok: true, pilot: pilotView(project) }); }
      return json(res, 200, b.on !== undefined ? pilotSwitch(b) : pilotSettings(b)); }
    if (url.pathname === '/api/pilot/retry' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, pilotRetry(projectArg(b.project))); }
    if (url.pathname === '/api/pilot') return json(res, 200, pilotView(projectArg(url.searchParams.get('project'))));
    // Phase 8 D, the pilot's log (docs/pilotlog.md): GET ?project=&before=&limit= → { actions, more, total }; POST (Mac only, 403 from the LAN)
    if (url.pathname === '/api/pilot/log') {
      if (req.method === 'POST') { const b = await readBody(req); const project = projectArg(b.project); const action = pilotlog.record(db, { project, planId: b.plan, sessionId: b.session, kind: b.kind, text: b.text }); notify('main:' + project); return json(res, 200, { ok: true, action }); }
      return json(res, 200, pilotlog.list(db, { project: projectArg(url.searchParams.get('project')), before: url.searchParams.get('before'), limit: url.searchParams.get('limit') }));
    }
    if (seg[0] === 'api' && seg[1] === 'main') { // the main conversation (docs/mainchat.md)
      if (!seg[2] && req.method === 'POST') { const b = await readBody(req); const project = projectArg(b.project); const message = mainchat.addMessage(db, { project, role: 'dev', text: b.text, source: 'page' }); notify('main:' + project); if (pilotOf(project).on) setImmediate(() => routeMessage(project, message)); return json(res, 200, { ok: true, message }); } // Phase 13 PIL: the triage, never a wait
      // Phase 8 A: « Lancer » on a proposed plan's card
      if (seg[2] === 'accept' && req.method === 'POST') return json(res, 200, await pilotAccept(await readBody(req)));
      // Phase 14 RAF, « Envoyer maintenant » in the thread: a turn of the pilot is cut, else what waits its window wakes now
      if (seg[2] === 'now' && req.method === 'POST') { const project = projectArg((await readBody(req)).project); const L = pilotProcs.get(project); const cut = !!(L && !L.proc.exited && L.proc.busy && L.proc.interrupt()); if (!cut) pilotWaker.now(project); return json(res, 200, { ok: true, cut }); }
      if (!seg[2]) return json(res, 200, mainchat.listMessages(db, projectArg(url.searchParams.get('project')), { before: url.searchParams.get('before'), limit: url.searchParams.get('limit'), q: url.searchParams.get('q') || '' }));
      if (seg[2] === 'pending' && req.method === 'GET') return json(res, 200, mainchat.pendingOf(db, projectArg(url.searchParams.get('project'))));
      if (seg[2] === 'transcripts' && req.method === 'GET') return json(res, 200, await mainchat.listTranscripts(db, projectArg(url.searchParams.get('project'))));
      if (seg[2] === 'import' && req.method === 'POST') { const b = await readBody(req); const project = projectArg(b.project); const r = await mainchat.importInto(db, project, b.path); notify('main:' + project); return json(res, 200, r); }
      return json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/memory') return json(res, 200, req.method === 'POST' ? addMemory(await readBody(req)) : memoryOf(projectArg(url.searchParams.get('project'))));
    // Escadrille en équipe (docs/team.md): the setting (the developer's cookie to write it, the token never returned), the status, the others, the collisions
    if (url.pathname === '/api/team') return json(res, 200, req.method === 'POST' ? writeTeam(await readBody(req), { guardKey: guardrails.keyFromCookie(req.headers.cookie) }) : teamView(projectArg(url.searchParams.get('project'))));
    // The Escadrille Équipe key (docs/vente/licence.md): checked offline; written by the developer's cookie only, never returned
    if (url.pathname === '/api/license') {
      if (req.method === 'POST') {
        if (!guardrails.keyMatches(guardrails.keyFromCookie(req.headers.cookie), GUARD_KEY)) return json(res, 403, { error: msg('srv.s.guardKey', { file: path.join(guardrails.dirOf(), 'guard-link') }) });
        const b = await readBody(req); const key = typeof b.key === 'string' ? b.key.trim() : b.key;
        if (key === null || key === '') license.remove(license.keyFileOf());
        else { const r = license.verify(key, { publicKey: existsSync(license.publicKeyFileOf()) ? readFileSync(license.publicKeyFileOf(), 'utf8') : null }); if (r.state === 'none' || r.state === 'invalid') return json(res, 400, { error: license.lineOf(r) }); license.save(key, license.keyFileOf()); }
        for (const p of teamProjects()) teamSync.forget(p); notify('main:*');
      }
      return json(res, 200, license.publicView(licenseNow()));
    }
    if (url.pathname === '/api/team/sync' && req.method === 'POST') { const project = projectArg((await readBody(req)).project); await teamSync.sync(project); return json(res, 200, teamView(project)); }
    if (url.pathname.startsWith('/api/resources')) return await resourcesRoute(req, res, url);
    if (url.pathname === '/api/templates') return json(res, 200, TEMPLATES.map(({ hints, ...t }) => t));
    if (url.pathname === '/api/escadrille' && req.method === 'POST') return json(res, 200, createEscadrille(await readBody(req)));
    if (url.pathname === '/api/tickets' && req.method === 'GET') { const project = projectArg(url.searchParams.get('project')); return json(res, 200, await tickets.listTickets({ source: url.searchParams.get('source'), project, key: secrets.get(project, 'linear'), q: url.searchParams.get('q') || '' })); }
    if (url.pathname === '/api/plan/from-tickets' && req.method === 'POST') { const b = await readBody(req); const project = projectArg(b.project); const { idea } = await tickets.ideaFromTickets({ project, ids: b.ids, idea: b.idea, key: secrets.get(project, 'linear') }); return json(res, 200, createEscadrille({ project, model: b.model, idea })); }
    if (seg[0] === 'api' && seg[1] === 'escadrille' && seg[2]) {
      const id = decodeURIComponent(seg[2]); const e = escadrilleOf(id); if (!e) return json(res, 404, { error: 'escadrille inconnue' });
      if (seg[3] === 'message' && req.method === 'POST') return json(res, 200, sendMessage(id, (await readBody(req)).text));
      if (seg[3] === 'install' && req.method === 'POST') { const { items } = validateInstall((await readBody(req)).items); setEscadrille(id, { install: JSON.stringify(items) }); touch(id); return json(res, 200, { ok: true }); }
      if (seg[3] === 'stop' && req.method === 'POST') { const p = planners.get(id); if (p) p.stop(); setEscadrille(id, { status: 'stopped' }); touch(id); return json(res, 200, { ok: true }); }
      const live = planners.get(id); const plan = e.plan_id ? planOf(e.plan_id) : null;
      return json(res, 200, { escadrille: { ...e, live: !!live && !live.exited, busy: !!live && live.busy }, messages: messagesOf(id), plan: plan ? withInstruction(plan) : null, state: plan ? stateOf(plan.id) : [], estimate: plan ? estimateOf(plan) : null });
    }
    // The review (docs/review.md)
    // Phase 16 PAIR: the end report, its files, the thread
    if (url.pathname === '/api/review/done' && req.method === 'GET') { try { return json(res, 200, reviewDone(url.searchParams.get('plan'), url.searchParams.get('session'))); } catch (e) { return json(res, e.status || 400, { error: e.message }); } }
    if (url.pathname === '/api/review/done/file' && req.method === 'GET') {
      const real = donethread.resolveCapture(doneRoot(rowOf(url.searchParams.get('plan'), url.searchParams.get('session'))), url.searchParams.get('path'));
      if (!real) return json(res, 404, { error: 'capture introuvable' });
      res.writeHead(200, { 'content-type': real.endsWith('.html') ? 'text/html; charset=utf-8' : 'image/png', 'cache-control': 'no-store' }); return res.end(readFileSync(real));
    }
    if (url.pathname === '/api/review/thread' && req.method === 'GET') { const p = url.searchParams.get('plan'); const sid = url.searchParams.get('session'); if (!rowOf(p, sid)) return json(res, 404, { error: 'session inconnue' }); return json(res, 200, { thread: donethread.threadOf(db, p, sid) }); }
    if (url.pathname === '/api/review/thread' && req.method === 'POST') { try { return json(res, 200, reviewThreadPost(await readBody(req), { key: guardrails.keyFromCookie(req.headers.cookie) })); } catch (e) { return json(res, e.status || 400, { error: e.message }); } }
    if (url.pathname === '/api/review' && req.method === 'GET') { const q = Object.fromEntries(url.searchParams); try { return json(res, 200, await review.openReview(q)); } catch (e) { return json(res, e.status || 400, { error: e.message }); } }
    if (url.pathname === '/api/reviews' && req.method === 'GET') return json(res, 200, await reviewsNow(projectFilter(url)));
    if (url.pathname === '/api/qa' && req.method === 'GET') return json(res, 200, { qa: qaList(projectFilter(url)) });
    if (url.pathname === '/api/qa/start' && req.method === 'POST') { try { return json(res, 200, await startProjectQa(await readBody(req))); } catch (e) { return json(res, e.status || 400, { error: e.message }); } }
    if (seg[0] === 'api' && seg[1] === 'review' && seg[2]) {
      const rid = decodeURIComponent(seg[2]);
      try {
        if (!seg[3] && req.method === 'GET') return json(res, 200, await review.reviewById(rid));
        if (seg[3] === 'file' && req.method === 'GET') return json(res, 200, await review.fileOf(rid, url.searchParams.get('path') || ''));
        if ((seg[3] === 'blob' || seg[3] === 'raw') && req.method === 'GET') { /* raw: the page's name for it since phase 7 (images and rendered docs) */ const b = await review.blobOf(rid, url.searchParams.get('path') || '', url.searchParams.get('side') === 'old' ? 'old' : 'new'); res.writeHead(200, { 'content-type': b.type, 'cache-control': 'no-store' }); return res.end(b.data); }
        if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
        const b = await readBody(req);
        if (seg[3] === 'comment' && !seg[4]) return json(res, 200, await review.addComment(rid, b));
        if (seg[3] === 'comment' && seg[4] && seg[5] === 'resolve') return json(res, 200, review.resolveComment(rid, seg[4], b));
        if (seg[3] === 'viewed') return json(res, 200, await review.setViewed(rid, b));
        if (seg[3] === 'submit') return json(res, 200, await review.submit(rid, b));
        // The page's per-item decision (a file, a doc, an image, a plan: Accepter, Refuser, Relancer) mapped onto the
        // review's verdict (2026-11-02: the page called /decide since phase 7, the route never existed, the click did nothing)
        if (seg[3] === 'decide') {
          const action = String(b.action || ''); const where = b.path ? `${b.path} : ` : '';
          if (action === 'reopen') return json(res, 200, { ok: true, reopened: true });
          const verdict = { accept: 'approve', reject: 'reject', retry: 'retry' }[action]; if (!verdict) return json(res, 400, { error: 'action : accept, reject, retry' });
          const reason = String(b.reason || '').trim();
          return json(res, 200, await review.submit(rid, { verdict, body: verdict === 'approve' ? reason : where + (reason || (verdict === 'retry' ? 'Relance demandée par le développeur.' : '')) }));
        }
        return json(res, 404, { error: 'not found' });
      } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    }
    if (seg[0] === 'api' && seg[1] === 'github' && (await ghroutes.handle(req, res, url, ghCtx))) return; // Phase 16 GH
    if (url.pathname === '/api/plans') return json(res, 200, plansList(projectFilter(url)));
    if (seg[0] === 'api' && seg[1] === 'plan' && seg[2]) {
      const id = decodeURIComponent(seg[2]); const plan = planOf(id); if (!plan) return json(res, 404, { error: 'unknown plan' });
      // Another formula of the plan (lib/formulas.mjs): the same checks as POST /api/plan, refused once a session has left
      if (seg[3] === 'formula' && req.method === 'POST') {
        const b = await readBody(req); const sw = formulaSwitch(plan, b?.tier); if (sw.error) return json(res, 400, { error: sw.error }); if (sw.same) return json(res, 200, { ok: true, formula: plan.formula });
        const { plan: next, errors } = validatePlan(withSettings(sw.plan, plan.project), { project: plan.project }); if (errors) return json(res, 400, { error: errors.join(' ; ') });
        const looser = autonomyRefusals(next); if (looser.length) return json(res, 400, { error: 'seulement durcir : ' + looser.join(' ; ') });
        const refused = planRefusals(next); if (refused.length) return json(res, 409, { error: 'plan déjà lancé : ' + refused.join(' ; '), sessions: refused });
        writeFileSync(path.join(PLANS_DIR, next.id + '.json'), JSON.stringify(next, null, 1)); upsertPlan(next);
        // The rows of the old formula never launched: gone when the session left the plan, else in the wave of the new one
        for (const r of db.prepare("select id from sessions where plan = ? and status in ('todo', 'later')").all(id)) { const s = next.sessions.find((x) => x.id === r.id); if (!s) db.prepare('delete from sessions where plan = ? and id = ?').run(id, r.id); else db.prepare('update sessions set status = ?, name = ? where plan = ? and id = ?').run(s.wave > 1 ? 'later' : 'todo', s.name, id, r.id); }
        notify('plan:' + id); return json(res, 200, { ok: true, formula: next.formula });
      }
      if (seg[3] === 'settings' && req.method === 'POST') {
        const b = await readBody(req); const next = { ...plan };
        if (b.autoMerge !== undefined) next.autoMerge = !!b.autoMerge;
        if (b.network !== undefined) { const { domains, errors } = validateNetwork(b.network); if (errors) return json(res, 400, { error: errors.join(' ; ') }); next.network = domains; } // as the project's settings: 127.0.0.1:3318 too
        // The autonomy of a plan is a contract: it may only get stricter (docs/autonomy.md)
        if (b.autonomy !== undefined) {
          const cur = autonomyOf(plan); if (!b.autonomy || typeof b.autonomy !== 'object' || Array.isArray(b.autonomy)) return json(res, 400, { error: 'autonomy : un objet { mode, … }' });
          const { value, errors } = autonomy.validateAutonomy({ ...cur, ...b.autonomy }); if (errors) return json(res, 400, { error: errors.join(' ; ') });
          const refused = autonomy.hardenErrors(cur, value, { sumBudget: sumBudgets(plan) }); if (refused.length) return json(res, 400, { error: 'seulement durcir : ' + refused.join(' ; ') });
          next.autonomy = value;
        }
        writeFileSync(path.join(PLANS_DIR, plan.id + '.json'), JSON.stringify(next, null, 1)); upsertPlan(next); notify('plan:' + id); return json(res, 200, { ok: true });
      }
      if (seg[3] === 'session' && seg[4]) {
        const sid = decodeURIComponent(seg[4]); if (!rowOf(id, sid)) return json(res, 404, { error: 'session inconnue' });
        if (seg[5] === 'messages') return json(res, 200, { messages: sessionMessages(id, sid) });
        if (seg[5] === 'pr' && req.method === 'GET') return json(res, 200, await sessionPrState(id, sid));
        if (seg[5] === 'diff' && req.method === 'GET') return json(res, 200, await sessionDiff(id, sid));
        if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
        const b = await readBody(req);
        if (seg[5] === 'message') return json(res, 200, sessionMessage(id, sid, b.text));
        if (seg[5] === 'now') return json(res, 200, sessionNow(id, sid));
        if (seg[5] === 'answer') return json(res, 200, sessionAnswer(id, sid, b));
        if (seg[5] === 'budget') return json(res, 200, sessionBudget(id, sid, b.usd ?? b.budget)); // { usd } (phase 13 PIL) or { budget }
        if (seg[5] === 'dismiss') return json(res, 200, sessionDismiss(id, sid, b.id));
        if (seg[5] === 'merge') { const r = await mergeSession(id, sid); return json(res, r.conflict || r.error ? 409 : 200, r); }
        if (seg[5] === 'terminal') return json(res, 200, await sessionTerminal(id, sid));
        if (seg[5] === 'resume') return json(res, 200, sessionResume(id, sid));
        if (seg[5] === 'stop') return json(res, 200, sessionStop(id, sid));
        if (seg[5] === 'open') return json(res, 200, await sessionOpen(id, sid));
        if (seg[5] === 'devserver') return json(res, 200, await sessionDevServer(id, sid));
        if (seg[5] === 'reviewed') return json(res, 200, await sessionReviewed(id, sid, { key: guardrails.keyFromCookie(req.headers.cookie), head: typeof b.head === 'string' ? b.head : null }));
        if (seg[5] === 'run-tests') return json(res, 200, await runTests(id, sid));
        if (seg[5] === 'continue-budget') return json(res, 200, continueBudget(id, sid));
        if (seg[5] === 'pr') return json(res, 200, await sessionPr(id, sid));
        return json(res, 404, { error: 'not found' });
      }
      if (seg[3] === 'retire' && req.method === 'POST') { const b = await readBody(req).catch(() => ({})); return json(res, 200, retirePlan(id, typeof b?.why === 'string' ? b.why : '')); }
      if (seg[3] === 'reopen' && req.method === 'POST') return json(res, 200, reopenPlan(id));
      if (seg[3] === 'story' && req.method === 'POST') return json(res, 200, writeStory(plan));
      if (!seg[3]) { const estimate = estimateOf(plan); return json(res, 200, { plan: withInstruction(plan), state: stateOf(id), log: logOf(id), estimate, formulas: formulaLines(plan, { defaultBudget: (plan.project && storedSettings(plan.project).budget) || DEFAULT_BUDGET_USD, dollarsPerPct: estimate?.calibration?.calibrated ? estimate.calibration.dollarsPerPct : num(vars.DOLLARS_PER_PCT, null) }), metrics: planMetrics({ db, planId: id }) }); }
      return json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/running' && req.method === 'GET') { const pf = projectFilter(url); const r = await runningNow(); return json(res, 200, pf ? { ...r, ours: r.ours.filter((o) => o.project === pf) } : r); }
    if (url.pathname.startsWith('/api/running/') && req.method === 'POST') {
      if (url.pathname === '/api/running/stop') return json(res, 200, await stopRunning(await readBody(req)));
      if (url.pathname === '/api/running/stop-all') return json(res, 200, await stopAllRunning());
    }
    if (url.pathname === '/api/learning' && req.method === 'GET') { let project; try { project = projectArg(url.searchParams.get('project')); } catch (e) { return json(res, 400, { error: e.message }); } learnedCache.delete(project); return json(res, 200, learning.learningReport({ db, project, running: distilling.has(project) })); }
    // The preferences file rewritten by the developer (phase 11 PX): his lines as he wrote them; a distilled line he kept
    // keeps its mark, a line he dropped is not proposed again (lib/learning.mjs reads the state at the next distillation)
    if (url.pathname === '/api/learning/preferences' && req.method === 'POST') { const b = await readBody(req); let project; try { project = projectArg(b.project); } catch (e) { return json(res, 400, { error: e.message }); } const r = learning.savePreferences(project, b.lines ?? b.text); learnedCache.delete(project); notify('learning:' + project); return json(res, 200, r); }
    // A task costed before it is launched (phase 11 PX, lib/costing.mjs): the three formulas composed from the kind of the
    // task, each session priced by the estimate and the learned gap; no planning session, nothing spent. With `tier`
    // and `launch`, the chosen formula becomes a plan (its cap at 1,5 × the estimate) launched at once.
    if ((url.pathname === '/api/costing' || url.pathname === '/api/costing/launch') && req.method === 'POST') {
      const b = await readBody(req); let project; try { project = projectArg(b.project); } catch (e) { return json(res, 400, { error: e.message }); }
      const text = String(b.text || '').trim(); if (!text) return json(res, 400, { error: msg('srv.e.idea') });
      const lang = b.lang === 'en' ? 'en' : 'fr';
      const draft = costing.buildPlan({ project, text, lang });
      const est = estimateOf(costing.allSessionsPlan(draft));
      const costed = costing.costing(draft, est, { registry: learnedOf(project) });
      if (url.pathname === '/api/costing') return json(res, 200, { plan: { id: draft.id, title: draft.title, kind: draft.kind }, costing: costed, calibration: est?.calibration || null });
      const tier = String(b.tier || 'recommended');
      let ready; try { ready = costing.launchable(draft, tier, costed, { defaultBudget: storedSettings(project).budget || DEFAULT_BUDGET_USD }); } catch (e) { return json(res, 400, { error: e.message }); }
      const { plan, errors } = validatePlan(withSettings(ready, project), { path: project, model: plannerModel(settingsOf(project).model), project });
      if (errors) return json(res, 400, { error: errors.join(' ; ') });
      if (planOf(plan.id)) plan.id = `${plan.id}-${randomBytes(2).toString('hex')}`;
      plan.costed = true;
      writeFileSync(path.join(PLANS_DIR, plan.id + '.json'), JSON.stringify(plan, null, 1)); upsertPlan(plan); notify('plan:' + plan.id);
      let r; try { r = await launch({ plan: plan.id }); } catch (e) { return json(res, 400, { error: e.message, plan: plan.id }); }
      return json(res, 200, { ok: true, plan: plan.id, title: plan.title, launched: r.launched, queued: r.queued });
    }
    if (url.pathname.startsWith('/api/demo') && await demo.route(req, res, url, { json, readBody })) return; // Mac only: not a phone route
    if (url.pathname.startsWith('/api/replies') && await replies.handle(req, res, url, { store: repliesStore, root: HERE, runSmall })) return; // FILE, Mac only; the writes are gated (docs/gate.md)
    if (url.pathname === '/api/usage') { const metrics = overallMetrics({ db, project: projectFilter(url) }); return json(res, 200, url.searchParams.get('only') === 'metrics' ? { metrics } : { ...usageReport({ db }), metrics }); }
    if (url.pathname.startsWith('/api/export/')) { const id = decodeURIComponent(url.pathname.slice(12)); const plan = planOf(id); if (!plan) return json(res, 404, { error: 'unknown plan' }); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${id}.json"` }); return res.end(JSON.stringify({ exported: now(), plan, state: stateOf(id), log: logOf(id, 100000) }, null, 1)); }
    if (url.pathname === '/api/plan' && req.method === 'POST') { const raw = await readBody(req); const project = projectOfRaw(raw); const { plan, errors } = validatePlan(withSettings(raw, project), { project }); if (errors) return json(res, 400, { error: errors.join(' ; ') }); guardSelfEdit(plan.project); const looser = autonomyRefusals(plan); if (looser.length) return json(res, 400, { error: "seulement durcir : " + looser.join(" ; ") }); const refused = planRefusals(plan); if (refused.length) return json(res, 409, { error: 'plan déjà lancé : ' + refused.join(' ; '), sessions: refused }); writeFileSync(path.join(PLANS_DIR, plan.id + '.json'), JSON.stringify(plan, null, 1)); upsertPlan(plan); notify('plan:' + plan.id); return json(res, 200, { ok: true, id: plan.id }); }
    if (url.pathname === '/api/launch' && req.method === 'POST') { const b = await readBody(req); return json(res, 200, await launch(b)); }
    if (url.pathname === '/api/note' && req.method === 'POST') { const b = await readBody(req); db.prepare('update sessions set note = ? where plan = ? and id = ?').run(String(b.note ?? ''), b.plan, b.session); notify('plan:' + b.plan); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...cors(req) }); res.write('event: hello\ndata: 1\n\n'); const key = url.searchParams.has('all') ? '*' : url.searchParams.get('plan') ? 'plan:' + url.searchParams.get('plan') : url.searchParams.has('running') ? 'running' : url.searchParams.get('main') ? 'main:' + path.resolve(url.searchParams.get('main')) : url.searchParams.get('project') ? 'project:' + path.resolve(url.searchParams.get('project')) : 'escadrille:' + url.searchParams.get('escadrille'); clients.set(res, key); req.on('close', () => clients.delete(res)); return; }
    // Docs and site (session J, phase 7): Escadrille's own docs/ as pages, and site/ as it is deployed.
    if (req.method === 'GET' && url.pathname.startsWith('/docs/') && url.pathname.endsWith('.md')) {
      const name = decodeURIComponent(url.pathname.slice(6)); const dp = path.join(HERE, 'docs', name);
      if (/[\\/]|\.\./.test(name) || !existsSync(dp) || !statSync(dp).isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
      const md = readFileSync(dp, 'utf8'); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(docPage(firstTitle(md) || name, renderMarkdown(md, { linkMd: 'md' }), SHELL_SERVER));
    }
    // The QA plan of a run (docs/qa.md): the file of its session, from the worktree until merged, then from the project
    if (req.method === 'GET' && url.pathname.startsWith('/qa/')) {
      const plan = planOf(decodeURIComponent(url.pathname.slice(4))); const lang = i18n.langOf(req);
      const { file } = plan?.qa ? qaFileOf(plan) : { file: null };
      const md = file ? readFileSync(file, 'utf8') : `# ${plan ? plan.title : '?'}\n\n${i18n.tr(lang, plan?.qa ? 'qa.writing' : 'qa.none')}`;
      res.writeHead(file ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(docPage(firstTitle(md) || 'QA', renderMarkdown(md, { linkMd: 'md' }), SHELL_SERVER));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/site/')) {
      const SITE = path.join(HERE, 'site'); let rel = decodeURIComponent(url.pathname.slice(6)); if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const sp = path.join(SITE, path.normalize(rel));
      if (!sp.startsWith(SITE + path.sep) || !existsSync(sp) || !statSync(sp).isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
      const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
      res.writeHead(200, { 'content-type': MIME[path.extname(sp)] || 'application/octet-stream' }); return res.end(readFileSync(sp));
    }
    // The UI: the chat at / and /e/:id, a plan at /plan/:id
    const file = url.pathname === '/' || url.pathname.startsWith('/e/') ? 'index.html' : url.pathname.startsWith('/plan/') ? 'plan.html' : url.pathname === '/flow' ? 'flow.html' : url.pathname === '/backlog' ? 'backlog.html' : url.pathname === '/resources' ? 'resources.html' : url.pathname === '/learning' ? 'learning.html' : url.pathname === '/replies' ? 'replies.html' : url.pathname === '/architecture' ? 'architecture.html' : url.pathname === '/review' || url.pathname.startsWith('/review/') ? 'review.html' : url.pathname.slice(1);
    if (url.pathname === '/i18n.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(i18n.bundle()); }
    const over = demo.overlay(path.normalize(file)); const fp = over || path.join(PUBLIC, path.normalize(file)); // the demo's file wins (docs/demo.md)
    if (!over && !fp.startsWith(PUBLIC) || !existsSync(fp) || statSync(fp).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const type = fp.endsWith('.html') ? 'text/html; charset=utf-8' : fp.endsWith('.js') ? 'text/javascript' : fp.endsWith('.css') ? 'text/css' : fp.endsWith('.svg') ? 'image/svg+xml' : fp.endsWith('.webmanifest') ? 'application/manifest+json' : fp.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }); res.end(readFileSync(fp));
  } catch (e) { json(res, e.status || 400, { error: e.message }); }
});
const RESUME_TEXT = 'Le serveur a redémarré pendant ton tour ; reprends où tu en étais, puis finis par ton bloc escadrille:state.';
loadPlans();
// At start, the branches merged while the server was down (or before it knew how to see them) leave the Revue, the waves move
setImmediate(() => syncMergedAll().then((plans) => { for (const plan of plans) checkWaves(plan).catch(() => {}); }).catch((e) => console.error('merged outside', e)));
migrateProjects();
review.init({ db, settingsOf, planOf, rowOf, plansOf: plansList, sessionMessage, mergeSession, onChange: (r) => { if (r.plan) notify('plan:' + r.plan); } });
// Escadrilles left "thinking" by a previous run of the server lost their process: they wait for the next message
db.prepare("update escadrilles set status = 'stopped' where status = 'thinking'").run();
// The sessions of the page that were alive when the server last stopped come back with --resume; an interrupted
// turn resumes on its own, once (docs/sessions.md, « La reprise seule »): if that turn ends in error, the session
// waits for the developer as any finished or broken turn; a handoff asked and not finished is asked again at the next turn
burstExpire(); // a burst past its until ends first: its sessions leave the page and are not resumed below
const overBursts = burst.finishedPlans(db);
for (const r of db.prepare("select plan, id from sessions where mode = 'page' and status in ('running', 'waiting')").all()) {
  // a session of a burst that is over is never resumed on its own (1 November: a draining burst relaunched one)
  if (overBursts.has(r.plan)) { try { const row = rowOf(r.plan, r.id); setState(r.plan, r.id, { mode: null, ...(row.status === 'running' ? { status: 'waiting' } : {}), pending: row.pending.filter((p) => p.kind !== 'permission') }); addSessionMessage(r.plan, r.id, 'system', msg('srv.b.notResumed')); } catch (e) { console.error('burst resume', e); } continue; }
  const plan = planOf(r.plan); const s = plan?.sessions.find((x) => x.id === r.id); const row = rowOf(r.plan, r.id);
  if (isRetired(plan)) { setState(r.plan, r.id, { mode: null, ...(row.status === 'running' ? { status: 'waiting' } : {}) }); continue; } // a retired plan never resumes at boot
  if (!s || !row.sessionId) continue;
  try {
    // the interrupted turn resumes with RESUME_TEXT, the messages left in the inbox in the same user message
    startProcess(plan, s, row, row.status === 'running' ? { lead: RESUME_TEXT } : {});
    if (row.status === 'running') {
      setPending(r.plan, r.id, [...rowOf(r.plan, r.id).pending.filter((p) => p.kind !== 'permission' && p.kind !== 'reply'), { id: fid('info'), kind: 'info', text: msg('srv.s.resumedAlone'), at: now() }]);
      addSessionMessage(r.plan, r.id, 'system', msg('srv.s.resumedMsg'));
    }
    else if (row.pending.some((p) => p.kind === 'permission')) setPending(r.plan, r.id, row.pending.filter((p) => p.kind !== 'permission'));
  } catch (e) { addSessionMessage(r.plan, r.id, 'system', 'Reprise impossible : ' + e.message); setState(r.plan, r.id, { mode: null }); }
}
setImmediate(limitsTick); // the paused sessions (status 'paused', kept in the base) resume alone at their reset, read again now
setImmediate(reapOrphans); // a 'running' row the loop above could not resume (no session_id, a failed start) waits, with a line for the pilot
armFallbacks(); // the fallbacks still pending come back from their dates (docs/autonomy.md)
listModels(); // the list of models, read once at startup (GET /api/models reads it again)
const SANDBOX = sandboxStatus(); // Linux: bubblewrap and socat on the PATH, else no session starts (lib/planner.mjs)
const GUARD_KEY = guardrails.guardKey({ port: PORT }); // ~/.config/escadrille/guard-key, its link in guard-link (unreadable by the sessions)
// The gate (docs/gate.md): the pilot's token (ESCADRILLE_PILOT_TOKEN, else ~/.config/escadrille/pilot-token next to the key), and
// whether the gate is off (ESCADRILLE_GATE=off, or a server under node --test): decided here, at start, never by a route or a setting
const PILOT_TOKEN = gate.pilotToken();
const GATE_OFF = gate.gateOff();
try { migrateNetworks(); } catch (e) { console.error('domaines : migration', e.message); } // once per project, idempotent (lib/domains.mjs)
server.listen(PORT, HOST, () => {
  abandonPlanQas(); // FIAB 6: the per-plan QA left waiting are abandoned (Dev, 6 Nov. 22:05)
  // What the socket is bound to, read back from the server itself (not from HOST)
  const { address } = server.address(); const open = address === '0.0.0.0' || address === '::';
  const lan = open ? Object.values(networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${PORT}`) : [];
  const where = open ? `listening on ${address} (LAN open${lan.length ? ': ' + lan.join(', ') : ''})` : `listening on ${address} only (./run.sh --lan or ${names.PREFIX}HOST=0.0.0.0 opens the LAN)`;
  const phones = devicesList().devices.length;
  reapSoon('start'); // the test apps no session owns any more (lib/testapps.mjs)
  console.log(`escadrille on http://localhost:${PORT}, ${where}, ${phones} phone${phones > 1 ? 's' : ''} paired, push to ${PUSH_URL}, database ${DB_FILE}, terminal ${TERMINAL}${PICKED_TERMINAL.error ? ' (' + PICKED_TERMINAL.error + ')' : ''}${SANDBOX.ok ? '' : ', NO SANDBOX: ' + SANDBOX.note + ' (sessions refused)'}${GATE_OFF ? ', GATE OFF: every local call acts (tests only, docs/gate.md)' : ''}`);
});
// The server closes what it opened: stdin of every process, a kill after 3 s, then it quits
const shutdown = (code = 0) => {
  demo.stop(); // its remains are swept at the next demo
  running.stopAllDevServers(); // SIGTERM to every dev server's group now, SIGKILL after 3 s
  const procs = [...planners.values(), ...[...live.values()].map((L) => L.proc)].filter((p) => !p.exited);
  live.clear(); // their exit events are ignored: a turn in progress stays 'running' and resumes on its own at the next start
  for (const p of procs) p.stop();
  const t0 = Date.now(); const tick = setInterval(() => { if ((procs.every((p) => p.exited) && !running.devServers().length) || Date.now() - t0 > 3500) { clearInterval(tick); try { db.close(); } catch {} process.exit(code); } }, 50);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// A restart from a shell (7 November): `kill -HUP <pid of node>` under ./run.sh exits with RESTART_CODE, and run.sh starts the
// server again, the supervisor kept; not supervised, a HUP stops it like a TERM. The sessions come back as after a merge.
process.on('SIGHUP', () => shutdown(vars.SUPERVISED === '1' ? RESTART_CODE : 0));
