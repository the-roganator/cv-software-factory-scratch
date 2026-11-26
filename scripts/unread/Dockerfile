# An image no registry serves, for the patching tests (test 19): the repository is real and public, the tag and the
# digest are not, so the registry answers at once that it has no such manifest. Nothing builds, runs or deploys this
# file; the vulnerability scan lists its pin, cannot read it, and must still make the day's other moves.
FROM ghcr.io/anchore/grype:unread@sha256:59dc528f800d81b51b1b274166578f17e552af07edeef69718dec259d74c004e
