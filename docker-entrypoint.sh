#!/bin/bash
set -e

# Newly created runtime files (database, WAL/SHM, logs, caches) hold secrets;
# without this they inherit the image default (022) and land world-readable.
umask 077

cd /app

APP_VERSION_FILE="/app/version.txt"
if [ -f "$APP_VERSION_FILE" ]; then
  APP_VERSION="$(tr -d '\r\n' < "$APP_VERSION_FILE")"
  export APP_VERSION
fi

CONFIG_ROOT="/config"
LEGACY_DATA_DIR="/app/data"
BUNDLED_DATA_DIR="/app/bundled-data"

CONFIG_MOUNTED=0
LEGACY_DATA_MOUNTED=0
if grep -q " ${CONFIG_ROOT} " /proc/mounts 2>/dev/null; then
  CONFIG_MOUNTED=1
fi
if grep -q " ${LEGACY_DATA_DIR} " /proc/mounts 2>/dev/null; then
  LEGACY_DATA_MOUNTED=1
fi
DEFAULT_DATA_DIR="${CONFIG_ROOT}/data"
DEFAULT_INDEXER_DEFINITIONS_PATH="${DEFAULT_DATA_DIR}/indexers/definitions"
DEFAULT_EXTERNAL_LISTS_PRESETS_PATH="${DEFAULT_DATA_DIR}/external-lists/presets"

DATA_DIR="${DATA_DIR:-${DEFAULT_DATA_DIR}}"
if [ "$DATA_DIR" = "${CONFIG_ROOT}/data" ]; then
  if [ "$CONFIG_MOUNTED" != "1" ] && [ "$LEGACY_DATA_MOUNTED" = "1" ]; then
    echo "Legacy data mount detected under /app; using legacy path for this run."
    echo "Mount ${CONFIG_ROOT} alongside /app/data for one run to migrate."
    DATA_DIR="$LEGACY_DATA_DIR"
  fi
fi

if [ -z "${INDEXER_DEFINITIONS_PATH:-}" ] || [ "$INDEXER_DEFINITIONS_PATH" = "$DEFAULT_INDEXER_DEFINITIONS_PATH" ]; then
  INDEXER_DEFINITIONS_PATH="${DATA_DIR}/indexers/definitions"
fi
if [ -z "${EXTERNAL_LISTS_PRESETS_PATH:-}" ] || [ "$EXTERNAL_LISTS_PRESETS_PATH" = "$DEFAULT_EXTERNAL_LISTS_PRESETS_PATH" ]; then
  EXTERNAL_LISTS_PRESETS_PATH="${DATA_DIR}/external-lists/presets"
fi
INDEXER_CUSTOM_DEFINITIONS_PATH="${INDEXER_CUSTOM_DEFINITIONS_PATH:-${INDEXER_DEFINITIONS_PATH}/custom}"
EXTERNAL_LISTS_CUSTOM_PRESETS_PATH="${EXTERNAL_LISTS_CUSTOM_PRESETS_PATH:-${EXTERNAL_LISTS_PRESETS_PATH}/custom}"
export DATA_DIR INDEXER_DEFINITIONS_PATH EXTERNAL_LISTS_PRESETS_PATH \
  INDEXER_CUSTOM_DEFINITIONS_PATH EXTERNAL_LISTS_CUSTOM_PRESETS_PATH

# camoufox resolves its browser cache from the XDG cache dir under HOME, so
# force HOME into /config/cache/home to keep the install on the config volume.
HOME="${CONFIG_ROOT}/cache/home"
export HOME
CAMOUFOX_CACHE_DIR="${HOME}/.cache/camoufox"
CAMOUFOX_TMP_DIR="${CONFIG_ROOT}/cache/tmp"
CAMOUFOX_NOTICE_FILE="${CONFIG_ROOT}/README-DO-NOT-DELETE-CAMOUFOX-CACHE.txt"
OWNERSHIP_STAMP_FILE="${CONFIG_ROOT}/.cinephage-ownership-stamp"

has_contents() {
  [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]
}

migrate_dir() {
  local src="$1"
  local dest="$2"
  local label="$3"

  if [ "$src" = "$dest" ]; then
    return 0
  fi

  if has_contents "$src"; then
    if [ ! -d "$dest" ] || [ -z "$(ls -A "$dest" 2>/dev/null)" ]; then
      echo "Migrating ${label} from ${src} to ${dest}..."
      mkdir -p "$dest"
      if ! cp -a "$src"/. "$dest"/; then
        echo "ERROR: Failed to migrate ${label} to ${dest}"
        echo "Ensure the container can read ${src} and write to ${dest}."
        echo "If needed, rerun once as root (user: 0:0) and set PUID/PGID."
        exit 1
      fi
    else
      echo "Skipping ${label} migration; destination already has data."
    fi
  fi
}

write_camoufox_notice() {
  if ! cat > "$CAMOUFOX_NOTICE_FILE" <<EOF
Cinephage Camoufox Cache (Do Not Delete)
=========================================

This instance uses Camoufox browser files for captcha solving.
Deleting the "cache" folder will force a full Camoufox redownload and may break captcha solving until it finishes.

Active paths:
- ${CAMOUFOX_CACHE_DIR}


If cleanup is required:
1. Stop Cinephage
2. Remove the cache folder
3. Start Cinephage and wait for Camoufox download to complete in logs
EOF
  then
    echo "Warning: Failed to write Camoufox cache notice at ${CAMOUFOX_NOTICE_FILE}"
  fi
}

should_run_recursive_ownership_fix() {
  local target_uid="$1"
  local target_gid="$2"
  local expected="${target_uid}:${target_gid}"

  if [ "${CINEPHAGE_FORCE_RECURSIVE_CHOWN:-0}" = "1" ]; then
    return 0
  fi

  if [ ! -f "$OWNERSHIP_STAMP_FILE" ]; then
    return 0
  fi

  local current
  current="$(tr -d '\r\n' < "$OWNERSHIP_STAMP_FILE" 2>/dev/null || true)"
  [ "$current" != "$expected" ]
}

mark_recursive_ownership_fix_complete() {
  local target_uid="$1"
  local target_gid="$2"
  local expected="${target_uid}:${target_gid}"

  if ! printf '%s\n' "$expected" > "$OWNERSHIP_STAMP_FILE" 2>/dev/null; then
    echo "Warning: Failed to write ownership stamp file at ${OWNERSHIP_STAMP_FILE}"
  fi
}

if [ "$(id -u)" = "0" ] && [ -z "${CINEPHAGE_REEXEC:-}" ]; then
  TARGET_UID="${PUID:-1000}"
  TARGET_GID="${PGID:-1000}"

  echo "Configuring runtime UID/GID: ${TARGET_UID}:${TARGET_GID}"

  # Keep startup deterministic and avoid mutating system users/groups.
  # We run as numeric UID:GID with gosu instead of editing /etc/passwd.
  if ! [[ "$TARGET_UID" =~ ^[0-9]+$ ]] || ! [[ "$TARGET_GID" =~ ^[0-9]+$ ]]; then
    echo "ERROR: PUID and PGID must be numeric values."
    echo "  Received: PUID='${TARGET_UID}', PGID='${TARGET_GID}'"
    exit 1
  fi

  # Create all necessary directories before dropping privileges
  mkdir -p \
    "$DATA_DIR" \
    "$INDEXER_DEFINITIONS_PATH" \
    "$EXTERNAL_LISTS_PRESETS_PATH" \
    "$INDEXER_CUSTOM_DEFINITIONS_PATH" \
    "$EXTERNAL_LISTS_CUSTOM_PRESETS_PATH" \
    "$CAMOUFOX_TMP_DIR" \
    "$CAMOUFOX_CACHE_DIR"

  if [ "$CONFIG_MOUNTED" = "1" ]; then
    migrate_dir "$LEGACY_DATA_DIR" "$DATA_DIR" "data"
  elif has_contents "$LEGACY_DATA_DIR"; then
    echo "Warning: legacy /app/data detected but ${CONFIG_ROOT} is not mounted."
    echo "Mount ${CONFIG_ROOT} and keep the legacy data mount for one run to migrate."
  fi

  if should_run_recursive_ownership_fix "$TARGET_UID" "$TARGET_GID"; then
    echo "Setting ownership on application directories..."
    chown -R "$TARGET_UID:$TARGET_GID" "$CONFIG_ROOT" 2>/dev/null || true
    # Exclude node_modules — owned by root, never written to at runtime,
    # and walking it on every boot adds meaningful startup latency
    find /app -mindepth 1 -maxdepth 1 -not -name 'node_modules' \
      -exec chown -R "$TARGET_UID:$TARGET_GID" {} +
    mark_recursive_ownership_fix_complete "$TARGET_UID" "$TARGET_GID"
  else
    echo "Skipping recursive ownership update (UID/GID unchanged)."
    chown "$TARGET_UID:$TARGET_GID" \
      "$CONFIG_ROOT" \
      "$DATA_DIR" \
      "$INDEXER_DEFINITIONS_PATH" \
      "$EXTERNAL_LISTS_PRESETS_PATH" \
      "$INDEXER_CUSTOM_DEFINITIONS_PATH" \
      "$EXTERNAL_LISTS_CUSTOM_PRESETS_PATH" \
      "$HOME" \
      "${HOME}/.cache" \
      "$CAMOUFOX_CACHE_DIR" \
      "$CAMOUFOX_TMP_DIR" \
      "$OWNERSHIP_STAMP_FILE" 2>/dev/null || true
  fi

  # Reclaim disk from camoufox installs killed mid-extraction (staged zip lives in TMPDIR).
  rm -rf "${CAMOUFOX_TMP_DIR:?}"/camoufox-* 2>/dev/null || true

  export CINEPHAGE_REEXEC=1
  exec gosu "${TARGET_UID}:${TARGET_GID}" "$0" "$@"
fi

if [ "$(id -u)" != "0" ] && [ -z "${CINEPHAGE_REEXEC:-}" ] && [ "$CONFIG_MOUNTED" = "1" ]; then
  migrate_dir "$LEGACY_DATA_DIR" "$DATA_DIR" "data"
fi

echo "Running as UID=$(id -u) GID=$(id -g)"

check_permissions() {
  local dir="$1"
  local name="$2"

  if [ ! -d "$dir" ]; then
    if ! mkdir -p "$dir" 2>/dev/null; then
      echo "ERROR: Cannot create $name directory at $dir"
      echo ""
      echo "Container is running as UID=$(id -u) GID=$(id -g)"
      echo ""
      echo "To fix this, ensure the host directory has correct ownership:"
      echo "  sudo chown -R $(id -u):$(id -g) $(dirname "$dir")"
      echo ""
      echo "Or set PUID and PGID to match your host user ('id -u' and 'id -g')."
      exit 1
    fi
  fi

  if ! touch "$dir/.write-test" 2>/dev/null; then
    echo "ERROR: Cannot write to $name directory at $dir"
    echo ""
    echo "Container is running as UID=$(id -u) GID=$(id -g)"
    echo "Directory ownership: $(ls -ld "$dir")"
    echo ""
    echo "To fix this, update the host directory ownership:"
    echo "  sudo chown -R $(id -u):$(id -g) $dir"
    echo ""
    echo "Or set PUID and PGID to match your host user ('id -u' and 'id -g')."
    exit 1
  fi
  rm -f "$dir/.write-test"
}

echo "Checking directory permissions..."
check_permissions "$DATA_DIR" "data"
check_permissions "$INDEXER_DEFINITIONS_PATH" "indexer definitions"
check_permissions "$EXTERNAL_LISTS_PRESETS_PATH" "external list presets"
echo "Directory permissions OK"

write_camoufox_notice

sync_bundled_data() {
  local src="$1"
  local dest="$2"
  local label="$3"

  if [ "$src" = "$dest" ]; then
    return 0
  fi

  if [ -d "$src" ]; then
    mkdir -p "$dest"
    if ! cp -a "$src"/. "$dest"/; then
      echo "Warning: Failed to sync ${label} into ${dest}"
    fi
  else
    echo "Warning: Bundled ${label} directory not found at ${src}"
  fi
}

sync_bundled_data "$BUNDLED_DATA_DIR/indexers" "$DATA_DIR/indexers" "indexers"
sync_bundled_data "$BUNDLED_DATA_DIR/external-lists" "$DATA_DIR/external-lists" "external lists"

mkdir -p "$INDEXER_CUSTOM_DEFINITIONS_PATH" "$EXTERNAL_LISTS_CUSTOM_PRESETS_PATH"

# Ensure the browser build paired with the launcher in this image is installed.
# `list installed` is a local check (~0.1s), so a normal restart skips the
# download and an image update with a new launcher provisions the matching
# browser automatically. Checking the installed list rather than the active
# build leaves a deliberate `camoufox set` choice alone.
# CAMOUFOX_AUTO_FETCH=false skips provisioning (air-gapped installs);
# GITHUB_TOKEN avoids GitHub API rate limits.
mkdir -p "$CAMOUFOX_TMP_DIR" 2>/dev/null || true
CAMOUFOX_PIN_TAG="$(node -e "try { console.log(require('./node_modules/camoufox/dist/data-files/browser-pin.json').tag); } catch {}" 2>/dev/null || true)"
CAMOUFOX_PIN_TAG="${CAMOUFOX_PIN_TAG#v}"
CAMOUFOX_INSTALLED="$(HOME="$HOME" ./node_modules/.bin/camoufox list installed 2>/dev/null | head -24 || true)"

if [ "${CAMOUFOX_AUTO_FETCH:-true}" = "false" ]; then
  echo "Camoufox auto-fetch disabled (CAMOUFOX_AUTO_FETCH=false); using the installed browser if any."
elif [ -n "$CAMOUFOX_PIN_TAG" ] && printf '%s' "$CAMOUFOX_INSTALLED" | grep -qF "$CAMOUFOX_PIN_TAG"; then
  echo "Camoufox browser paired with this release is installed"
else
  if has_contents "$CAMOUFOX_CACHE_DIR"; then
    echo "Updating Camoufox to the build paired with this release (large download, may take several minutes)..."
  else
    echo "Downloading Camoufox (first run only; large download, may take several minutes)..."
  fi
  mkdir -p "$CAMOUFOX_CACHE_DIR"

  # Stage into the persisted cache volume instead of the container overlay: an
  # install killed mid-extraction leaves its staging files behind, and
  # sweep-on-boot keeps that bounded. Extraction runs silently after the
  # download progress bar finishes.
  FETCH_START="$(date +%s)"
  echo "Fetching Camoufox (extraction runs silently after the download bar finishes)..."
  if HOME="$HOME" TMPDIR="$CAMOUFOX_TMP_DIR" ./node_modules/.bin/camoufox fetch; then
    FETCH_END="$(date +%s)"
    echo "Camoufox ready in $((FETCH_END - FETCH_START))s ($(HOME="$HOME" ./node_modules/.bin/camoufox active 2>/dev/null | head -1))"
  else
    echo "Warning: Failed to provision the Camoufox browser. Captcha solving will retry when a solve needs it."
  fi
fi

echo "Starting Cinephage..."
if [ -n "${APP_VERSION:-}" ]; then
  echo "App version: ${APP_VERSION}"
fi
exec "$@"
