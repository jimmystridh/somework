#!/bin/sh
# Builds the Operations (fleet dashboard) image: the UI bundle first when it is missing or older than its sources, then the server image.
#
#   scripts/build-ops-image.sh TAG [--ship HOST] [--rebuild-bundle] [--help]
#
#   TAG                the image is tagged agent-cluster-fleet:TAG
#   --ship HOST        afterwards sends the image to HOST (user@host or an ssh alias): docker save | gzip | ssh HOST docker load
#   --rebuild-bundle   builds the UI bundle even when it looks current
#
# Needs docker, and dx (`cargo install dioxus-cli --version 0.7.4 --locked`) when the bundle has to be built.
set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail

usage() { sed -n 2,10p "$0" | sed 's/^# \{0,1\}//'; }

tag=""
host=""
force_bundle=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --ship) [ "$#" -ge 2 ] || { echo "--ship needs a HOST" >&2; exit 2; }; host=$2; shift 2 ;;
        --rebuild-bundle) force_bundle=1; shift ;;
        -*) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
        *) [ -z "$tag" ] || { echo "only one TAG is allowed" >&2; exit 2; }; tag=$1; shift ;;
    esac
done

[ -n "$tag" ] || { usage >&2; exit 2; }
case "$tag" in *[!A-Za-z0-9._-]*) echo "the tag may only hold letters, digits, dot, underscore and hyphen" >&2; exit 2;; esac
case "$host" in -*) echo "the host must not start with a hyphen" >&2; exit 2;; *[!A-Za-z0-9._@:-]*) echo "the host may only hold letters, digits, dot, underscore, hyphen, at and colon" >&2; exit 2;; esac

root=$(cd "$(dirname "$0")/.." && pwd)
dashboard=$root/dashboard
bundle=$dashboard/bundle
image=agent-cluster-fleet:$tag

bundle_sources="ui/src ui/Cargo.toml shared/src shared/Cargo.toml public Dioxus.toml Cargo.toml Cargo.lock"

bundle_is_current() {
    [ -f "$bundle/index.html" ] || return 1
    cd "$dashboard"
    [ -z "$(find $bundle_sources -newer "$bundle/index.html" | head -n 1)" ]
}

build_bundle() {
    command -v dx >/dev/null 2>&1 || { echo "dx is not installed: cargo install dioxus-cli --version 0.7.4 --locked" >&2; exit 1; }
    cd "$dashboard"
    rm -rf target/dx/fleet-ui/release/web/public
    dx bundle --release --platform web --package fleet-ui
    rm -rf bundle
    cp -R target/dx/fleet-ui/release/web/public bundle
    cp public/style.css bundle/style.css
}

if [ "$force_bundle" = 1 ] || ! (bundle_is_current); then
    echo "building the UI bundle"
    build_bundle
else
    echo "the UI bundle is current"
fi

cd "$root"
DOCKER_BUILDKIT=1 docker build -f dashboard/Dockerfile -t "$image" .
echo "built $image"

if [ -n "$host" ]; then
    docker save "$image" | gzip | ssh -o BatchMode=yes "$host" docker load
    echo "loaded $image on $host"
fi
