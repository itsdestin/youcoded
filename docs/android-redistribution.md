# Android runtime source collection and redistribution limits

## Status and limits

The runtime preserves exact-input evidence and npm legal material. Setting
`YOUCODED_COLLECT_SOURCES=1` runs `app/runtime/collect-aports.py` after resolution
and version stamping, before packaging notices. The release workflow enables it.
There is no hand-supplied dossier prerequisite or nine-review-file attestation gate.

The collector retains exact-commit aports tarballs, complete recipe directories,
evaluated SHA512 inputs (including local patches), downloaded source bytes and
recognizable original notices. APKBUILD evaluation/fetch/verification runs only
in an isolated, unprivileged Alpine abuild container, not the host shell.

**Verification is not legal clearance.** The release command rejects objective missing
source/checksum/notice residuals before upload. It does not fabricate failures for
unrelated requirements: MIT/Apache dependencies generally need their notices, not
blanket corresponding-source delivery; offline rebuilds and APK signature authentication
are separate checks. Bash, Git, readline and separately distributed copyleft runtime
libraries retain their actual source obligations, including relevant linked dependencies
and compilation/installation scripts. Actual linking/license selections and any
applicable installation requirements must still be reviewed. Claude preinstallation is
subject to its published Commercial Terms, unmodified binary/authentication and users'
own credentials/direct billing, not an invented separate private-permission requirement.
`coverage.json:review_notes` records these distinctions; it does not assert clearance.
A real collected source archive and final APK/AAB inspection remain unverified locally.

## What the build retains

`app/runtime/build-runtime.sh` creates `<runtime-output>/evidence/`:

- `root/` and `sysroot/`: separate index snapshots, `inputs.json`, `owners.json`,
  and original per-package `pkginfo/*.PKGINFO`. Metadata is read from each APK's
  control stream **before extraction**. Name, version, architecture, license,
  origin and full aports commit must agree with the selected index entry.
- Exact APK URL, SHA256, original index checksum, requested dependency constraints,
  selected provider edges and explicit extraction/exclusion status. SHA256 locks
  cached inputs and later variants against silent replacement. **Hashes are not
  signature authentication**: the evidence says this explicitly. Signature
  authentication is a separate supply-chain check, not a copyright-license gate.
- A combined `inputs.json` with runtime versus build-only sysroot scopes. The
  sysroot list is conservative build-input coverage, **not** a claim that every
  sysroot package is shipped. The current gate conservatively requires sources
  for every extracted origin in both scopes.
- Runtime `packaged-files.jsonl` maps copied executables/libraries and data-tree
  files to original APK owners and input/output hashes. Library and executable
  entries describe path/shim adjustments; data copies are not binary patches.
- `outputs.json` hashes every JNI/runtime-asset output; `non-apk-inputs.json`
  records original musl and Claude package hashes and retained local sources.
  `youcoded-runtime/` includes exact scripts, musl patch, C helpers, native npm
  source/header trees, installer/service source, build configuration and npm lock.
  The original musl tarball and full COPYRIGHT and host compiler/tool versions
  are retained separately. Patched musl is rebuilt against the recorded sysroot.

The first resolution locks each cache's root/sysroot inputs. Changed roots,
indexes or APK bytes require a **new** `YOUCODED_RUNTIME_CACHE`; do not hand-edit
an existing release lock. `pins.env` still pins only the Alpine branch, not exact
APK versions. A fresh cache can therefore resolve a newer set; the generated
lock describes the actual build, not a hypothetical set from earlier research.
Retain the cache's actual APKs and evidence when preparing a dossier.

The resolver deliberately is not a replacement APK solver: unresolved names,
ambiguous providers, conflicts and unsupported constraints fail. Version ordering
uses `apk version -t`, configurable with `YOUCODED_APK_VERSION`. CI uses
`docker run --rm alpine:3.24 apk version -t`; it does not execute on-phone binaries
or change their pins. A local build without `apk` must provide an equivalent
command; no home-grown semver ordering is used for Alpine comparisons.

`build-backend.sh` preserves Markdown, docs and node-pty third_party in place.
Before platform/test trimming, `preserve-npm-legal.py` additionally copies named
license/licence/COPYING/copyright/NOTICE/AUTHORS/PATENTS/README/legal/third-party
files into `backend.tgz:legal/npm-notices/`, retaining their original paths. The
nested installed production-package inventory records post-trim retention.
This is a conservative preservation mechanism, not proof that every applicable
notice has a recognizable filename. Renderer-bundled dependencies are **not**
covered by this backend inventory.

`assets/legal/` sits outside the web bundle deletion path and is already included
by the variant Gradle assets source directory. It contains the runtime inventory,
YouCoded MIT text, full musl COPYRIGHT, modification/source directions, and an
explicit incomplete-collection notice. When collection is enabled, validated
original per-origin notice files are copied there before APK/AAB packaging.
There is no renderer/UI change in this work; no new About link is claimed.

## Executable source collection

From the app repo on an isolated CI runner with Docker:

```sh
YOUCODED_COLLECT_SOURCES=1 ./gradlew assembleReleaseTest
```

Normal Gradle prerequisites apply. CI stamps the version before Gradle. The output
is `app/build/runtime/<variant>/sources/`, generated from that variant's evidence:

- `aports/<commit>.tar.gz`: retained GitHub aports archive bytes from the exact
  `.PKGINFO` commit, shared across origins at the same commit.
- `origins/<origin>/<commit>/recipe/`: every file in that origin's exact recipe
  directory, including patches, install scripts and triggers. Relative links to
  files inside the recipe are materialized as their original target bytes; escaping,
  missing and cyclic targets fail. The retained aports archive preserves original links.
- `distfiles/` below each origin: every evaluated `sha512sums` input. Local inputs
  are copied from the recipe; remote inputs come from `abuild fetch verify`.
- `sha512sums.txt`: evaluated checksums from the container. Unsupported, empty or
  duplicate checksum entries fail rather than claiming source coverage.
- `notices/`: byte-for-byte LICENSE/LICENCE/COPYING/COPYRIGHT/NOTICE/AUTHORS/PATENTS
  files found in recipe files and top-level tar/zip source archives, with original
  member names in the manifest. Nested archives and arbitrary notice filenames
  are not recursively interpreted. This is preservation, not semantic completeness.
- `crates/` below ripgrep: original crates.io archives selected by the source Cargo.lock,
  checked against its SHA256 values, with original embedded dependency notices retained.
  This is not a claim that Cargo has been configured for a fully offline rebuild.
- `coverage.json`: hashes of retained bytes, exact origin/commit set, original
  archive URL, recipe/file references, embedded crate archives, evidence and stamped
  local-input binding, objective residuals and review notes. No reviewer-authored files
  are required.

The container mounts only the current origin's collection directory, runs as the
host's nonroot UID/GID with all capabilities dropped and no-new-privileges, and
has network for upstream fetches. It does not mount the Docker socket or app
checkout. Use a disposable CI worker: APKBUILDs are executable upstream code.
The collector image is built from Alpine 3.24 plus abuild/build tools; it is not
claimed to reproduce the original binary compiler environment.

Validation compares the complete retained recipe file set with the downloaded
aports archive and verifies **every evaluated SHA512 input**, including patches.
The HTTPS exact-commit archive URL is recorded; its hash is byte binding, not an
independent signature authentication scheme. Original Node LICENSE files found
in source archives are retained, but full embedded-notice coverage is unproven.
`abuild fetch` is not `cargo vendor`; ripgrep's crates.io lock entries are collected
separately and checksum-verified for their original notices. Non-registry dependencies
fail rather than being silently skipped. Missing named notices stop validation rather
than being replaced with invented license text.

The release workflow retains the incomplete collection as an Actions artifact
before its distribution gate, including when later gating fails. This is CI
transport only, not durable source publication or a written source offer.

## Release gate and transport

After the release build the workflow invokes:

```sh
python3 -I app/runtime/runtime-redistribution.py release \
  app/build/runtime/release app/build/runtime/release/sources \
  "app/build/outputs/YouCoded-${APP_VERSION}-android-corresponding-source.tar.xz" \
  "app/build/outputs/apk/release/YouCoded-${APP_VERSION}.apk" \
  "app/build/outputs/bundle/release/YouCoded-${APP_VERSION}.aab"
```

It rejects a missing/mismatched collection and any objective missing-input residuals.
Its binary-inspection path checks final APK/AAB runtime and notice bytes and nested
backend npm material. Passing fixture tests proves these structural checks, not an
actual release's source completeness or legal clearance. Broad review notes cannot
substitute for missing source bytes, and they are not permanent arbitrary blockers.
**No full runtime build, container run or complete real source archive is asserted
by the offline tests.** The `archive` command can retain a validated incomplete
collection plus evidence as an xz archive; that is not a complete-source claim.

Only after the gate does the existing authorized release workflow upload APK,
AAB and matching source archive/checksum together, with explicit source directions
in release notes. Actions artifact retention is merely CI transport, not durable
source distribution. Keep corresponding source available wherever the binaries
remain available; verify anonymous downloads when publication is authorized.
This implementation neither publishes anything nor creates a written source
offer. GitHub's automatic app-only source zip is not this runtime source archive.

Primary obligation references: [GPLv2 §3](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html),
[GPLv3 §§1,6](https://www.gnu.org/licenses/gpl-3.0.html),
[GCC runtime exception](https://www.gnu.org/licenses/gcc-exception-3.1.html),
[Apache §4](https://www.apache.org/licenses/LICENSE-2.0),
[Claude preinstallation conditions](https://code.claude.com/docs/en/legal-and-compliance).
These explain the collection scope; they do not replace version-specific license texts.
