# Refreshing the app profile

**When:** a release is published and you want the desktop app to run it. **Cost:** one update, one
restart.

The app and the repo drift apart easily and silently. This is the procedure, and the two things that
have gone wrong doing it.

## What the profile records

`~/.dsh/profiles/<name>/package.json` holds two separate things, and both matter:

```json
"dependencies": { "dsh-openai-live": "0.4.0" },
"dsh": { "profile": { "bundles": [ "...", "dsh-openai-live" ] } }
```

- **`dsh.profile.bundles` holds the bundle *id*.** It is a set of ids, so installing a new version of
  the *same* id is an **update** — the id is already there and gets replaced.
- **The dependency is an exact pin**, not a range. It will not move on its own; an update has to
  rewrite the pin.

## Do not uninstall first

The bundle id is unchanged between versions, so installing `0.5.x` over `0.4.0` is an update. An
uninstall is not merely unnecessary — it is worse: it removes the row the running app is serving from,
and an interruption between the two leaves the app with no voice plugin at all.

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

1. **The pin moved.** `~/.dsh/profiles/<name>/package.json` shows the new version.
2. **The manifest moved.** `node_modules/dsh-openai-live/package.json` shows the new version. Read the
   manifest, not a directory listing — a listing is not evidence about resolution.
3. **No harness shadow.** `node_modules/@deepseek-ai` must be **absent** from the profile. Any entry
   there is a second copy of a harness package, which breaks the host's own tools silently.
4. **It is loaded and working.** Speak a request and hear a failure *reason* rather than the model's
   flat refusal. That is the S0 behaviour and it is the only check that exercises the whole chain.

## The drift this procedure exists to catch

The profile held `dsh-realtime-responder 0.1.0` while the repo was at `0.4.0` — the plugin installed,
the code current, and the running app several releases behind. Nothing errored; the app just behaved
like an older version.

`pnpm probe:delegation <profile>` reports it directly: **green against the current build, red against
a stale profile**. Run it against the app profile after any refresh, and after any release that claims
to fix something the user should be able to hear.

## Profile backups

The profile accumulates `package.json.bak-*` and `cordis.patch.yml.bak-*` files beside the live ones.
They are the only copy of a working configuration if an install goes wrong — leave them alone.

## If it installs the wrong version

**The installer resolves from a pnpm metadata cache, and that cache is not revalidated on every run.**
Observed: the app installed `dsh-openai-live@0.3.0` while the registry's `latest` was `0.5.1` — and
*downgraded* a profile that already held `0.4.0`. Nothing was broken. The resolver consulted a cached
packument from roughly fifteen hours earlier and never went to the network.

**Your registry check is not the installer's check.** `curl`-ing the registry proves what the registry
*serves*; it says nothing about what the installer *resolves*. Both checks are needed, and only the
second one predicts what lands.

Two caches are involved:

```
~/Library/Caches/pnpm/v11/metadata/registry.npmjs.org/<pkg>.jsonl        # abbreviated, used for resolution
~/Library/Caches/pnpm/v11/metadata-full/registry.npmjs.org/<pkg>.jsonl   # full packument
```

Each is newline-delimited JSON; read its `dist-tags` line to see what the installer believes `latest`
is:

```bash
python3 -c "
import json,sys
p='$HOME/Library/Caches/pnpm/v11/metadata/registry.npmjs.org/<pkg>.jsonl'
for line in open(p):
    if line.strip():
        d=json.loads(line)
        if d.get('dist-tags'): print(d['dist-tags'])"
```

**Fix — park the stale entries and let the next resolution fetch fresh:**

```bash
mkdir -p /tmp/pnpm-metadata-parked
for v in metadata metadata-full; do
  f="$HOME/Library/Caches/pnpm/v11/$v/registry.npmjs.org/<pkg>.jsonl"
  [ -f "$f" ] && mv "$f" /tmp/pnpm-metadata-parked/"$v-<pkg>.jsonl"
done
```

Then re-add in the app. A missing entry is the state you want: the resolver has nothing stale to serve.

**A specifier written from a bad resolution outlives it.** The installer also rewrites the pin from
whatever it resolved — `"dsh-openai-live": "0.3.0"` became `"^0.3.0"` — and `^0.3.0` is
`>=0.3.0 <0.4.0`: it excludes `0.5.1` **whatever the cache says**. So clearing the cache is necessary
and not sufficient. Either re-add by name so the installer rewrites the specifier from a good
resolution, or set the specifier explicitly and re-resolve.

**Check all three, in this order:** the cache (what the installer thinks `latest` is) → the pin in the
profile's `package.json` (what it is *allowed* to resolve) → the installed manifest in `node_modules`
(what actually landed). A green cache with a stale pin still installs the old version, and that
combination looks exactly like the cache fix not working.
