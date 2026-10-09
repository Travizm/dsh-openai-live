# Releasing

The publish is the irreversible step, so this is the order it runs in and the two ways it has gone
wrong. Everything here has been paid for once.

## 1. Pre-publish gates

```bash
pnpm gate                                  # leak scan · build · declared deps · typecheck · coverage · built-artifact
pnpm leakscan                              # tracked files only — the tarball is a second, unreviewed product
```

Then pack everything and **inspect the bytes**, because what packing *includes* is not what anyone
wrote:

```bash
rm -rf /tmp/packcheck && mkdir -p /tmp/packcheck
for d in packages/* .; do ( cd "$d" && pnpm pack --pack-destination /tmp/packcheck >/dev/null 2>&1 ); done
# extract and read the file list AND the bytes; a credential-derived identifier ships just as permanently
```

## 2. Check the RANGE, not just the version

**This is the check that is easy to skip and expensive to skip.** A 0.x caret **minor-locks**:
`^0.2.0` means `>=0.2.0 <0.3.0`. So shipping the seam as `0.3.0` puts it *outside* every published
consumer's declared range, and the consumer installs a **second copy** of it — the duplicate-package
defect that breaks a host silently.

Read the ranges **the published packages declare**, not the ones your working tree rewrites:

```bash
curl -s https://registry.npmjs.org/<pkg>/<version> | python3 -m json.tool | grep -A8 dependencies
```

`workspace:^` in the tree rewrites against **the current tree**, so the local pack cannot tell you what
existing consumers require. Only the registry can.

Inside every declared range → **patch**. That also means existing consumers receive the fix with no
action and no bundle upgrade. Outside → you are either bumping every consumer too, or you are shipping
a duplicate.

## 3. Publish through pnpm, never npm

```bash
pnpm publish --access public                 # from each package dir, dependency order
```

`pnpm pack` rewrites `workspace:^` to a real range. **`npm publish` does not** — it ships
`package.json` verbatim, and `workspace:` is a pnpm-only protocol, so the package is
**uninstallable by everyone**:

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:^
```

It is invisible from every local check: the pack is correct, the publish reports success, the registry
serves the version. The defect exists only in the published *manifest*.

Order is **library → adapters → the aggregating bundle last**. A bundle published before its
dependencies points at versions that do not exist yet, and that state is visible to anyone installing
in the window between.

## 4. Promotion is asynchronous, unordered, and not your success message

A publish is submitted, then promoted, per package, in no particular order — a minute or two, and
which lands first has nothing to do with publish order. `npm view` answers from a **local cache** and
will keep reporting the old `latest`, which is indistinguishable from a publish that did not land.

Poll the registry itself:

```bash
for p in <pkgs>; do
  curl -s -H 'Cache-Control: no-cache' "https://registry.npmjs.org/$p" \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('dist-tags',{}).get('latest'))"
done
```

## 5. Verify by installing — the success message is not evidence

```bash
rm -rf /tmp/verify && mkdir -p /tmp/verify && cd /tmp/verify
npm init -y >/dev/null && npm install <bundle>@<version>
```

This is the only pass that sees what a consumer gets, and it catches what the poll cannot:
uninstallable manifests, dead source-map references, an install-time graph that differs from yours, a
package resolving to **two versions**, and stray files `files` pulled in.

Then confirm the thing you shipped actually arrived — grep the installed `lib/` for the symbol or event
the release was about.

## 6. When a broken version ships

You cannot fix it in place: npm will not accept a second publish of the same version, and a conflict
naming an already-submitted version is *confirmation it is pending*, not an error to clear.

1. **Bump a patch** — a new version that is the fix.
2. **Publish that** through pnpm.
3. **Deprecate the broken one**, so nobody installs it by accident:

```bash
npm deprecate <pkg>@<broken> "Broken manifest: <what> and cannot be installed. Use <fixed>."
```

Deprecation is the honest signal; deleting is not possible and silence is not honest.
