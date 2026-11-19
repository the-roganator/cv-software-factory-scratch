#!/usr/bin/env bash
# Asks the cluster to start, in each guarded namespace, a pod on an image the pipeline did not sign, one on an image
# signed by someone else and one on an image of ours that the namespace does not run, and keeps Kyverno's answers in
# deploy/test/admission-refusals.json, for milestone 7's red-team harness to show. Run it with every image policy
# enforcing (Deny), as `main` has them: not during a `try-the-line` run, which switches `factory-images` to Audit, and
# which scripts/policy-hash.ts, run first, refuses, as Argo CD then reports the policy changed.
#
# Each request is a server-side dry run: it passes through admission exactly as a real one does, and nothing is made.
# The pods meet the restricted Pod Security Standard the namespaces enforce, so a refusal is the image policy's own.
#
#   unsigned        the factory's (or, in `website`, the app's) amd64 image from inside a build: build.yml signs the
#                   multi-platform index it pushes, not each platform's manifest in it, so this one is ours, on GHCR,
#                   by digest, and unsigned
#   other-identity  an image the namespace runs, on our GHCR, signed, but not by build.yml on main: the arm64 image
#                   from inside the same build of the factory (in `website`, of the factory's browser), which
#                   .github/workflows/other-identity.yml signed on the branch `refusal/other-identity`, keyless, as
#                   itself. So it gets past the checks of its registry and its place, and is refused for its
#                   signature. The branch is kept, unmerged, so the workflow that signed it can be read, and its
#                   identity is never build.yml's on main. In `flagd`, where no image of ours runs, it is refused for
#                   its place first, as `misplaced` is
#   misplaced       ours, on GHCR, but not an image the namespace runs, so refused before its signature is looked
#                   at: in `website` the factory's own image (only its browser runs there), in `scoreboard` the
#                   factory's browser (only the factory's own image runs there), in `flagd` the factory's own (no
#                   image of ours runs there), elsewhere the app's
#   other-digest    in `flagd` alone, flagd's own image at an earlier release, by its digest: its copy admits the one
#                   digest it names, and no other from flagd's repository
#
# `flagd` has no `unsigned` case: no image of ours runs there, so one is refused as misplaced before its signature is
# looked at.
#
# Before it asks, it reads who signed each image of ours (scripts/signed-by.ts, as the deploy watch reads it), and
# stops unless the unsigned ones carry no signature, the other-identity ones only another's, and the misplaced ones
# build.yml's on main; each answer keeps what it found. The record keeps the hash of the four copies of the policy it
# was taken against (scripts/policy-hash.ts), which apps/factory/test/refusal-records.test.ts holds to deploy/.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory-scratch}"
here=$(dirname "$0")
# REFUSALS_OUT writes the record elsewhere, as `make guardrails` takes it, and leaves deploy/test/ as it is.
out="${REFUSALS_OUT:-$here/../deploy/test/admission-refusals.json}"
# The policies as the cluster runs them, or nothing asked.
taken=$(node "$here/policy-hash.ts" admission-refusals)

# Signed builds: the factory's and its browser's from commit 22bcfa0, the app's from f68c10c.
factory=ghcr.io/the-roganator/cv-software-factory-scratch/factory@sha256:6f6f15b1a42831c024c8ce6e5dd4277f554643f3f5db1bfc8b0687a75ee78e61
website=ghcr.io/the-roganator/cv-worlds-worst-website-scratch@sha256:01178e7aaa98c14efce403e6adb453e703e8752d8ffdff6adf2a40638c22c984
browser=ghcr.io/the-roganator/cv-software-factory-scratch/factory-browser@sha256:7355a49a0b3980ad01206bc49605abdc058ea47b3756941c9d612b7e71309f00
# The amd64 manifests inside the factory's build and the app's, which carry no signature of their own.
factory_unsigned=ghcr.io/the-roganator/cv-software-factory-scratch/factory@sha256:acf7c8f9fa626fdaf3e5d9fcea3bd265167d83720910c04028f864837cfc13e1
website_unsigned=ghcr.io/the-roganator/cv-worlds-worst-website-scratch@sha256:48131565040f216414501e4cc9265dbcde491ba1c46bf6a79ae1975e631972cd
# The arm64 manifests inside the factory's build and its browser's, which other-identity.yml signed.
factory_other=ghcr.io/the-roganator/cv-software-factory-scratch/factory@sha256:f8787c6b7996738c2068a6ab4f4ae9ba4280133dee6ef5e0dfc21d9811db9067
browser_other=ghcr.io/the-roganator/cv-software-factory-scratch/factory-browser@sha256:6f1d8f48f9bdbeacbc65110d17a48392b8acab0ac3cfe11c053d65ff725051ea
flagd=ghcr.io/open-feature/flagd:v0.16.3@sha256:a11ae82ec6e40e89edae4327392a1e4ffc03e211f1b724879bb35b2e4f271bb3

# Who signed each image of ours, read once, by digest, and what each case needs of it. Kept aside with the answers.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
signed() { cat "$work/${1##*:}" 2>/dev/null || echo null; } # image: who signed it, or null for one not ours
for image in "$factory_unsigned" "$website_unsigned" "$factory_other" "$browser_other" "$factory" "$website" "$browser"; do
  node "$here/signed-by.ts" "$image" >"$work/${image##*:}"
done
need() { # image signature: stops unless the image is signed so
  local got
  got=$(signed "$1" | jq -r .signature)
  if [[ $got != "$2" ]]; then
    echo "$1 must be signed $2, and is $got: $(signed "$1" | jq -r .message)" >&2
    exit 1
  fi
}
need "$factory_unsigned" none
need "$website_unsigned" none
need "$factory_other" other
need "$browser_other" other
need "$factory" pipeline
need "$website" pipeline
need "$browser" pipeline

try() { # namespace case image: one JSON line, what was asked, who signed it and what the cluster answered
  local ns=$1 kind=$2 image=$3 answer outcome
  if answer=$(kubectl --context "$context" -n "$ns" create --dry-run=server -o name -f - 2>&1 <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: admission-refusal
spec:
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: refused
      image: $image
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: [ALL]
EOF
  ); then outcome=admitted; else outcome=refused; fi
  jq -cn --arg ns "$ns" --arg kind "$kind" --arg image "$image" --arg outcome "$outcome" --arg answer "$answer" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson signed "$(signed "$image")" \
    '{namespace: $ns, case: $kind, image: $image, at: $at, outcome: $outcome,
      message: ($answer | sub("^Error from server: error when creating \"STDIN\": "; ""))}
      + if $signed then {signature: $signed.signature, signedBy: $signed.by} else {} end'
}

# Kept aside until every case has answered, so a script that stops leaves the record as it was.
answers="$work/answers"
{
  for ns in factory runners red-team website scoreboard flagd; do
    case "$ns" in
      website) try "$ns" unsigned "$website_unsigned" ;;
      flagd) try "$ns" other-digest "$flagd" ;;
      *) try "$ns" unsigned "$factory_unsigned" ;;
    esac
    case "$ns" in
      website) try "$ns" other-identity "$browser_other" ;;
      *) try "$ns" other-identity "$factory_other" ;;
    esac
    case "$ns" in
      website | flagd) try "$ns" misplaced "$factory" ;;
      scoreboard) try "$ns" misplaced "$browser" ;;
      *) try "$ns" misplaced "$website" ;;
    esac
  done
} >"$answers"
jq -s --argjson taken "$taken" '$taken + {cases: .}' "$answers" >"$out"
# As `make check` would have it.
[ -n "${REFUSALS_OUT:-}" ] || pnpm exec biome format --write "$out" >/dev/null
jq -r '.cases[] | "\(.outcome)  \(.namespace)  \(.case): \(.message)"' "$out"
