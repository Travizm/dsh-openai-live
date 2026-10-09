# Refreshing the app profile

**When:** a release is published and you want the desktop app to run it. **Cost:** one update, one
restart.

The app and the repo drift apart easily and silently. This is the procedure, and the three things that
have gone wrong doing it.

## What the profile records

`~/.dsh/profiles/<name>/package.json` holds two separate things, and both matter:

```json
"dependencies": { "dsh-openai-live": "0.4.0" },
"dsh": { "profile": { "bundles": [ "...", "dsh-openai-live" ] } }
```

- **`dsh.profile.bundles` holds the bundle *id*.** It is a set of ids, so installing a new version of
  the *same* id is an **update** — the id is already there and gets replaced.
- **The dependency specifier is not yours to keep.** It is written by the installer from whatever it
  resolved, and re-derived on the next install. An exact `"0.4.0"` came back as `"^0.3.0"` — a caret
  range — without anyone asking for it. Treat the specifier as output, not as configuration.

## Do not uninstall first

The bundle id is unchanged between versions, so installing `0.5.x` over `0.4.0` is an update. An
uninstall is not merely unnecessary — it is worse: it removes the row the running app is serving from,
and an interruption between the two leaves the app with no voice plugin at all. Worse still, the
profile's own patch layer carries a `dsh-realtime-responder` row (below), so a naked uninstall leaves
that row pointing at a package that is not installed — a boot error, discovered at restart.

If an install is ever needed for a *different* id, that is a different situation: two rows with the
same id across layers is the conflict that aborts boot.

## The profile's own patch layer survives — and it must

Patches apply in this order:

```
bundle patches (in dsh.profile.bundles order)
  → the profile's own cordis.patch.yml
    → $DSH_HOME/cordis.patch.yml
      → --patch overlays
```

The profile's layer comes **after** the bundles, so it wins. Yours carries one row, and it is
load-bearing — it is where the session the voice steers is set:

```yaml
- id: dsh-realtime-responder
  name: "dsh-realtime-responder"
  config:
    sessionId: session-ea70184a-6ed5-4eb7-b907-548ffd8b48f5
    answerTimeoutMs: 45000
    maxPromptChars: 4000
```

**An id-targeted patch replaces the matched row's whole config; it does not merge.** So every field
the bundle ships is restated here rather than inherited — and if a future release *adds* a field to
that row, this override silently drops it. After any upgrade that changes the shipped row, restate
every field you mean to keep. The failure mode is a setting that does nothing, with no error.

## The restart is what loads it

A bundle installed into a *running* app is **registered and not loaded**. It appears in
`dsh.profile.bundles` and contributes nothing until the app boots again. This is the single most common
false alarm: a clean install that appears to have done nothing.

Install → restart → then test.

## Verify

1. **The manifest moved.** `node_modules/dsh-openai-live/package.json` shows the new version, and so
   does each sibling the bundle pulls in. Read the manifest, not a directory listing — a listing is not
   evidence about resolution. **Do not verify on the pin alone:** the installer rewrites it from its
   own resolution, so it can read correctly while the wrong version is installed, and can read wrongly
   while the right one is.
2. **No harness shadow.** `node_modules/@deepseek-ai` must be **absent** from the profile. Any entry
   there is a second copy of a harness package, which breaks the host's own tools silently.
3. **The symbol is present, not just the version.** For S0 that means `delegation-settled` in the
   installed `dsh-realtime-responder/lib/`. A version number is a claim; the code is the evidence.
4. **It is loaded and working.** `pnpm probe:delegation <profile>` from the repo is the check: green,
   with `refused` carrying the controller's reason and the key redacted. Run it against the *app*
   profile, not the workspace — it resolves the bundle from the profile's own `node_modules`, which is
   the only thing that makes it an installed-profile check.
5. **The spoken reason is NOT a refresh check.** S0 preserves the reason on the bus as
   `realtime-agent/delegation-settled`; **narrating it through `appendCommentary` is S1's story
   *Spoken failures*, and has not landed.** Until it does, a failure still speaks
   `UNANSWERED_NOTICE` — *"Sorry — I can't take care of that right now."* — exactly as before S0.
   So a refresh cannot be verified by listening for the reason, and looking for it there sends you
   hunting a defect that is really an unbuilt story. That is the worst kind of check: one whose
   failure mode cannot tell "not implemented" from "broken".

## The drift this procedure exists to catch

The profile held `dsh-realtime-responder 0.1.0` while the repo was at `0.4.0` — the plugin installed,
the code current, and the running app several releases behind. Nothing errored; the app just behaved
like an older version.

`pnpm probe:delegation <profile>` reports it directly: **green against the current build, red against
a stale profile**. Run it against the app profile after any refresh, and after any release that claims
to fix something the user should be able to hear.

## Profile backups

The profile accumulates `package.json.bak-*`, `pnpm-workspace.yaml.bak-*` and `cordis.patch.yml.bak-*`
files beside the live ones. They are the only copy of a working configuration if an install goes wrong
— leave them alone.

## If it installs the wrong version

**First suspect, and the one that has actually bitten: the profile runs a supply-chain gate that
refuses anything published in the last 24 hours.** It is not in your global npm or pnpm config, which
is why checking there says the gate is unset. It is in the profile:

`~/.dsh/profiles/<name>/pnpm-workspace.yaml`, and pnpm records the *effective* values into
`~/.dsh/profiles/<name>/node_modules/.pnpm-workspace-state-v1.json` — which is the authoritative
copy, since it is what pnpm actually applied:

```yaml
minimumReleaseAge: 1440          # minutes — 24 hours
minimumReleaseAgeExclude:        # versions exempted from that gate
  - dsh-openai-live@0.3.0
  - dsh-openai-live@0.4.0
```

So a just-published release is **not installable, by design**, and the resolver silently falls back to
the newest version that *is* permitted — usually an older one an earlier install allow-listed.
Observed: `dsh-openai-live@0.3.0` installed **twice** while the registry served `0.5.1`, because every
S0 package was 38–43 minutes old and the newest permitted version was `0.3.0`. No error, no warning:
the gate is working exactly as intended, and the result looks like a bug.

Measure it before theorising:

```bash
python3 -c "
import json,subprocess,datetime
d=json.loads(subprocess.run(['npm','view','<pkg>','time','--json'],capture_output=True,text=True).stdout)
now=datetime.datetime.now(datetime.timezone.utc)
for v in ('0.4.0','0.5.0','0.5.1'):
    age=(now-datetime.datetime.fromisoformat(d[v].replace('Z','+00:00'))).total_seconds()/60
    print(f'  {v:8} age={age:7.1f} min  ' + ('EXCLUDED by the 24h gate' if age < 1440 else 'permitted'))"
```

**Two ways out.** *Wait* — the gate opens 24 hours after publish, with no edit at all, and it is the
honest option. Or *allow-list the release*, which is the app's own mechanism (it appends each version
it installs to `minimumReleaseAgeExclude`): add the bundle **and every sibling it brings**, because the
gate applies to each package independently.

**The `overrides:` block will defeat half a release without failing.** The same file can pin a sibling
to a version the new bundle does not accept:

```yaml
overrides:
  dsh-realtime-agent: 0.2.3      # new bundle requires ^0.2.5 — the override wins, silently
```

Overrides beat dependency ranges. The bundle upgrades, the overridden sibling does not, and the release
looks complete while being half-landed: the responder arrives and the agent-side change does not.
Check `overrides:` against the new bundle's `dependencies` on every refresh. This is the failure that
only a symbol check catches.

**Second suspect: a stale pnpm metadata cache.** Real, but it was *not* the cause above — the installer
had already fetched fresh metadata (`dist-tags` showed `0.5.1`) and rejected it on age. Check it only
after the gate:

```
~/Library/Caches/pnpm/v11/metadata/registry.npmjs.org/<pkg>.jsonl        # abbreviated
~/Library/Caches/pnpm/v11/metadata-full/registry.npmjs.org/<pkg>.jsonl   # full packument
```

Each is newline-delimited JSON; read its `dist-tags` line to see what the installer believes `latest`
is. A missing entry is the state you want — nothing stale to serve.

**Your registry check is not the installer's check.** `curl`-ing the registry proves what the registry
*serves*; it says nothing about what the installer *resolves*. Both checks are needed, and only the
second one predicts what lands.

**Check all four, in this order:** the gate (`minimumReleaseAge` plus the exclude list) → the
`overrides:` rows → the installed manifest in `node_modules` (and the symbol inside it) → and only then
the cache. A green registry behind a closed gate still installs the old version, and that looks exactly
like everything else failing.
