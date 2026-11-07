# Security policy

## Reporting a vulnerability

Please report it privately through GitHub's private vulnerability reporting: open the repository
**GabFranck/Escadrille**, go to **Security**, then **Advisories**, then **Report a vulnerability**.
Do not open a public issue or pull request for a vulnerability.

You will get a first answer within **7 days**. Please include what you found, how to reproduce it, and
which version or commit you tested.

## In scope

- the server (`server.mjs`, `lib/`), including its HTTP routes and device-token guard;
- the web page (`public/`);
- the phone app (`phone/`);
- the scripts (`scripts/`, `install.sh`).

## Out of scope

- Claude Code itself: report it to Anthropic;
- the projects calmdev drives (their code, their dependencies, their own settings).

## What leaves the Mac

By default the server answers on localhost only; the LAN needs a paired device token. The **Access** view
(`/#acces`) and [`docs/access.md`](docs/access.md) list everything that can leave the Mac and how to
revoke it.
