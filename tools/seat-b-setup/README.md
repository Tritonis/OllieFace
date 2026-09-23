# seat-b-setup

One-time setup for the two-seat co-op rig (#243). Two scripts, one per machine:

- `node tools/seat-b-setup/seat-b.mjs` -- run **on machine B**. Walks steps 1-6 of the issue.
- `node tools/seat-b-setup/seat-a.mjs` -- run **on machine A**. Writes `.twoseat.local.json`
  (contract E, gitignored by #242 -- do not commit it) and an SSH key, then prints the exact
  line to append to B's `authorized_keys`.

Both are idempotent: re-running either script re-detects each step and skips whatever is
already done. Nothing machine-specific is written into the repo; the local config lives at
the repo root as `.twoseat.local.json`, outside git.

## Before you start (about an hour)

Have ready:
- A second Steam account ("account 2") -- its login and password.
- Access to https://partner.steamgames.com/ for app 5150570 (a dev key to redeem, or an
  existing grant).
- Administrator access on machine B (OpenSSH Server install and the scheduled task both
  need an elevated shell; the wizard detects elevation and refuses those steps otherwise
  rather than silently no-op'ing).

A VM on machine A satisfies the "two Steam seats" requirement for protocol checks (lobby,
invite, join) -- it does **not** give you performance parity, so don't use it to judge frame
timing or render load.

## What each script changes on the machine

`seat-b.mjs` only touches machine state (installs OpenSSH Server, starts sshd, adds a
firewall rule scoped to `LocalSubnet`, registers the `OllieFace-TwoSeat` scheduled task)
after you type `y` at an explicit prompt; every other step just detects and explains.

`seat-a.mjs` generates an SSH key pair under `~/.ssh/` if one doesn't already exist, and
writes `.twoseat.local.json`. It does not touch machine B remotely -- copying the public key
is a manual step the wizard prints instructions for.

## Final step

Once both machines report done, run on machine A:

```
npm run twoseat -- --preflight-only
```

**Assumption:** #242 is expected to support a preflight-only mode; this wizard assumes that
exact flag spelling. If #242 lands it under a different name, the controller aligns this line
(and the printed instruction in `seat-a.mjs`'s `preflight` step) at merge time.

## Layout

- `lib/detect.mjs` -- pure output parsers (reg query, PowerShell, schtasks, whoami).
- `lib/commands.mjs` -- command-line builders, including the exact contract-D scheduled-task line.
- `lib/config.mjs` -- contract-E shape and validation.
- `lib/steps.mjs` -- the step-running harness (detect -> explain -> confirm -> act -> re-verify).
- `lib/steps-b.mjs`, `lib/steps-a.mjs` -- the concrete step lists per machine.
- `lib/elevation.mjs` -- elevation detection via `whoami /groups`.

Tests: `tests/seat-b-setup.test.mjs` drives all of the above with injected `exec`/`answers`,
no real shelling out or file writes outside a temp dir.
