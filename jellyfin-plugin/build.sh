#!/usr/bin/env bash
#
# Builds the Cinephage Jellyfin plugin into a Jellyfin plugin repository
# directory: dist/<targetAbi>/manifest.json plus the package zip the manifest
# points at. The app serves both from /api/jellyfin-plugin/.
#
# Runs the .NET SDK in a container so the dev box needs no SDK install.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${VERSION:-$(tr -d '[:space:]' < VERSION)}"
TARGET_ABI="${TARGET_ABI:-12.4.0.0}"
DOTNET_IMAGE="${DOTNET_IMAGE:-mcr.microsoft.com/dotnet/sdk:10.0}"
ASSEMBLY="Cinephage.Plugin.Jellyfin"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$PWD":/src -v "$WORK":/out -w /src "$DOTNET_IMAGE" \
	dotnet publish "${ASSEMBLY}.csproj" -c Release -o /out/publish \
	-p:Version="${VERSION}" --nologo

python3 package.py "$WORK/publish" dist "$VERSION" "$TARGET_ABI"
