# calmdev

**AI goes fast. Take a breath.** Describe a feature once. calmdev plans parallel Claude Code sessions,
runs them sandboxed on your Mac, and only interrupts you when one needs you.

![A plan in flight: what waits for you on top, the parallel sessions below](docs/phase9/hero.jpg)

## Install

You need Node 22.13+, git, and Claude Code 2.1 already logged in (run `claude` once). macOS or Linux.

```sh
git clone https://github.com/Gabfranck/calmdev-private calmdev && cd calmdev && ./install.sh
```

Or, from the folder of a project, with nothing to clone: `npx github:Gabfranck/calmdev` (same checks, same options; the data stays in `~/.config/calmdev`).

The repository, the folder, `.escadrille/`, `~/.config/escadrille/` and the `ESCADRILLE_*` variables keep the
project's former name: they are identifiers, kept so that existing installs go on working.

`install.sh` checks what is missing and says how to get it (it installs nothing itself), then starts the
server and opens it: the Mac app when it is installed (`/Applications/calmdev.app`, see `docs/desktop.md`), else
`http://localhost:3078` in the default browser (`./install.sh --tab` always opens a tab, `./install.sh --no-open` opens nothing,
`./run.sh --open` reopens it while the server runs). No `npm install`: the server has no dependency. Ctrl-C stops it;
`./install.sh` starts it again. Without Claude Code, `install.sh` says so and starts nothing. It does not check that
Claude Code is logged in (that cannot be told without a network call): run `claude` once and log in before the first plan.
`node scripts/fresh-install.mjs` replays this install on a clean clone and a temporary home (what the maintainers run before publishing).

**First plan.** A fresh install knows no project: the home asks for the folder of one. Type the path of any git
repository, or pick one of the folders Claude Code used lately. Installing from a project folder
(`cd ~/Dev/my-app && ~/escadrille/install.sh`) adds that folder for you. No project at hand? A throwaway one:

```sh
mkdir ~/escadrille-demo && cd ~/escadrille-demo && git init -q && git -c user.name=demo -c user.email=demo@localhost commit -q --allow-empty -m init
```

Then describe a feature. A read-only session reads the project, asks its questions once (a recommendation
already checked on each), and writes a plan with its price. Nothing runs before you click « Launch ».
The interface follows your browser's language (English or French); `?lang=en` or `?lang=fr` on any address forces one.

## Why you can leave it running

- **Local.** The server listens on `127.0.0.1` only. calmdev has no account and calls no service of its own;
  your sessions talk to Anthropic through your own Claude Code. The pages load nothing from outside, except a
  Google font a page really uses (the app itself runs on system fonts). The other outbound calls: the phone's push notice goes through Expo once you have paired a phone, the
  team relay only for a project where you switched it on, and GitHub (push the branch, open the PR) only on your
  click in the app on the Mac: neither a paired device nor a token pushes.
- **No dependency.** The server is Node's standard library only (`node:http`, `node:sqlite`); state stays in
  one SQLite file next to it.
- **Sandboxed.** Each session runs in Claude Code's sandbox, in its own git worktree and branch: no network
  unless the plan names a domain (none by default), `.env` and keys unreadable, `git push` and the cloud CLIs
  denied. The Access view (`/#acces`) shows all of it, read from the code when you open it.
- **Capped.** A dollar ceiling on every session (5 $ unless the plan says otherwise), an optional one per plan,
  an alert at 80 %. By default a merge waits for your click, and no mode merges with red tests.

[`docs/access.md`](docs/access.md) details what sessions can read, write and reach.

## How it works

1. **The chat.** Say your idea, by keyboard or voice.
2. **The questions.** One planning session reads the project and asks everything it needs, once.
3. **The plan.** Sessions in waves, each with a model, a ceiling and a usage estimate.
4. **The flight.** Each session in its own worktree; a wave starts when what it waits for is merged. Near
   the context limit a session hands off to a fresh one. Permissions, questions and reviews land in one list.
5. **The phone** (optional, Expo). Follow the plan, answer a permission. Launching and merging stay on the Mac.

## Known limits

- Linux is tested with stubs, not yet on a real machine ([`docs/linux.md`](docs/linux.md)); it needs
  bubblewrap and socat. Windows has no sandbox; WSL2 counts as Linux.
- Claude Code 2.1.x only: the stream and transcripts are read as 2.1 writes them.
- Interactive sessions leave no transcript, so the usage estimate does not see them.
- The phone app needs Expo Go and has not been tested on a real iPhone yet.

## More

- [`docs/flot.md`](docs/flot.md): the intended flow and the project rules (the design notes in `docs/` are in French).
- [`docs/autonomy.md`](docs/autonomy.md): Surveillé (default), Guidé, Autonome, and the guards no mode lifts.
- [`site/`](site/index.html): the landing page, static; [`site/DEPLOY.md`](site/DEPLOY.md) to put it online yourself.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md) · [`SECURITY.md`](SECURITY.md)
  (private reporting on GitHub).

Source available under the [Functional Source License 1.1, MIT Future License](LICENSE) (FSL-1.1-MIT):
use it for anything but a competing product, and each version becomes MIT two years after its release.
The team features (`team/`, `lib/team.mjs`, `public/team.js`) are under the [Escadrille Team License](team/LICENSE):
free to read and try for 30 days, a subscription beyond.
