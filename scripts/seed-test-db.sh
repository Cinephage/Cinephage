#!/usr/bin/env bash
# Build a swappable TEST database from the production one.
#
#   scripts/seed-test-db.sh
#   DATA_DIR=data/test npm run dev        # then browse localhost:5173
#
# What you get (data/test/cinephage.db, gitignored like everything in data/):
#   - a full copy of your real library/settings/metadata
#   - downloads + indexers HARD-DISABLED: nothing in test mode can ever
#     grab, poll, or touch a real client
#   - real root folders marked read-only; two writable QA folders under
#     data/test/media are the only approval targets
#   - known logins: your admin username + password "testpass123", plus a
#     viewer account "qatester" / "testpass123"
#   - fixture requests in every status + notifications for both accounts
#
# Re-run any time to rebuild from the current production DB.
set -euo pipefail

SRC="${DATA_SRC:-data/cinephage.db}"
DEST_DIR="${DATA_DIR:-data/test}"
TEST_PASSWORD="testpass123"

if [ ! -f "$SRC" ]; then
	echo "No database at $SRC — set DATA_SRC or run from the repo root."
	exit 1
fi

mkdir -p "$DEST_DIR/media/movies-standard" "$DEST_DIR/media/movies-anime" "$DEST_DIR/media/tv-standard"
sqlite3 "$SRC" ".backup '$DEST_DIR/cinephage.db'"

HASH=$(node -e "import('better-auth/crypto').then(async m => console.log(await m.hashPassword('$TEST_PASSWORD')))")

ADMIN_ID=$(sqlite3 "$DEST_DIR/cinephage.db" "SELECT id FROM user WHERE role='admin' ORDER BY createdAt LIMIT 1;")

sqlite3 "$DEST_DIR/cinephage.db" <<SQL
-- Safety: nothing in test mode may reach real clients or indexers.
UPDATE download_clients SET enabled = 0;
UPDATE indexers SET enabled = 0;

-- Known-password admin + a viewer account.
UPDATE account SET password = '$HASH'
	WHERE "providerId" = 'credential' AND "userId" = '$ADMIN_ID';

INSERT INTO user (id, name, email, emailVerified, username, displayUsername, role, language, banned, createdAt, updatedAt)
SELECT 'seed-test-viewer', 'QA Tester', 'qatester@test.local', 1, 'qatester', 'QA Tester', 'user', 'en', 0, datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM user WHERE id = 'seed-test-viewer');

INSERT INTO account (id, "userId", accountId, providerId, password, createdAt, updatedAt)
SELECT 'seed-test-viewer-account', 'seed-test-viewer', 'seed-test-viewer', 'credential', '$HASH', datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM account WHERE id = 'seed-test-viewer-account');

-- Real folders become read-only; only QA folders are writable targets.
UPDATE root_folders SET read_only = 1 WHERE media_type = 'movie';
INSERT INTO root_folders (id, name, path, media_type, media_sub_type, is_default, read_only, default_monitored)
	VALUES ('seed-movies-standard', 'QA Movies', '$PWD/$DEST_DIR/media/movies-standard', 'movie', 'standard', 1, 0, 1)
	ON CONFLICT(path) DO UPDATE SET read_only = 0, is_default = 1;
INSERT INTO root_folders (id, name, path, media_type, media_sub_type, is_default, read_only, default_monitored)
	VALUES ('seed-movies-anime', 'QA Movies Anime', '$PWD/$DEST_DIR/media/movies-anime', 'movie', 'anime', 1, 0, 1)
	ON CONFLICT(path) DO UPDATE SET read_only = 0, is_default = 1;
INSERT INTO root_folders (id, name, path, media_type, media_sub_type, is_default, read_only, default_monitored)
	VALUES ('seed-tv-standard', 'QA TV', '$PWD/$DEST_DIR/media/tv-standard', 'tv', 'standard', 1, 0, 1)
	ON CONFLICT(path) DO UPDATE SET read_only = 0, is_default = 1;

-- Fixture requests: one per status. Pending ones use synthetic tmdb ids
-- (99xxxx) so the availability sweep can't fulfill them against the copied
-- library; posters/titles are borrowed from real rows for display.
DELETE FROM request_notifications;
DELETE FROM requests;

INSERT INTO requests (id, media_type, tmdb_id, title, poster_path, year, status, seasons, requested_by, created_at, updated_at)
	SELECT 'seed-req-pending-movie', 'movie', 990001, m.title, m.poster_path, m.year, 'pending', NULL, 'seed-test-viewer', datetime('now','-2 days'), datetime('now','-2 days')
	FROM movies m WHERE m.poster_path IS NOT NULL ORDER BY m.tmdb_id LIMIT 1;

INSERT INTO requests (id, media_type, tmdb_id, title, poster_path, year, status, seasons, requested_by, created_at, updated_at)
	SELECT 'seed-req-pending-series', 'series', 990002, s.title, s.poster_path, s.year, 'pending', '[1,2]', 'seed-test-viewer', datetime('now','-1 day'), datetime('now','-1 day')
	FROM series s WHERE s.poster_path IS NOT NULL ORDER BY s.tmdb_id LIMIT 1;

INSERT INTO requests (id, media_type, tmdb_id, title, poster_path, year, status, requested_by, auto_approved, decided_by, decided_at, created_at, updated_at)
	SELECT 'seed-req-approved', 'movie', 990003, m.title, m.poster_path, m.year, 'approved', 'seed-test-viewer', 1, 'seed-test-viewer', datetime('now','-1 day'), datetime('now','-2 days'), datetime('now','-1 day')
	FROM movies m WHERE m.poster_path IS NOT NULL ORDER BY m.tmdb_id DESC LIMIT 1;

INSERT INTO requests (id, media_type, tmdb_id, title, poster_path, year, status, seasons, requested_by, decided_by, decided_at, fulfilled_at, created_at, updated_at)
	SELECT 'seed-req-fulfilled', 'series', 990004, s.title, s.poster_path, s.year, 'fulfilled', '[1]', 'seed-test-viewer', '$ADMIN_ID', datetime('now','-6 days'), datetime('now','-2 days'), datetime('now','-7 days'), datetime('now','-2 days')
	FROM series s WHERE s.poster_path IS NOT NULL ORDER BY s.tmdb_id DESC LIMIT 1;

INSERT INTO requests (id, media_type, tmdb_id, title, poster_path, year, status, requested_by, decided_by, decided_at, failure_reason, created_at, updated_at)
	SELECT 'seed-req-failed', 'movie', 990005, m.title, m.poster_path, m.year, 'failed', 'seed-test-viewer', '$ADMIN_ID', datetime('now','-3 days'), 'No writable destination configured', datetime('now','-3 days'), datetime('now','-3 days')
	FROM movies m WHERE m.poster_path IS NOT NULL ORDER BY m.tmdb_id LIMIT 1 OFFSET 1;

INSERT INTO requests (id, media_type, tmdb_id, title, poster_path, year, status, requested_by, decided_by, decided_at, decline_reason, created_at, updated_at)
	SELECT 'seed-req-declined', 'movie', 990006, m.title, m.poster_path, m.year, 'declined', 'seed-test-viewer', '$ADMIN_ID', datetime('now','-9 days'), 'Not available in decent quality', datetime('now','-9 days'), datetime('now','-9 days')
	FROM movies m WHERE m.poster_path IS NOT NULL ORDER BY m.tmdb_id LIMIT 1 OFFSET 2;

INSERT INTO requests (id, media_type, tmdb_id, title, poster_path, year, status, requested_by, decided_at, decline_reason, created_at, updated_at)
	SELECT 'seed-req-expired', 'movie', 990007, m.title, m.poster_path, m.year, 'expired', 'seed-test-viewer', datetime('now','-15 days'), 'expired', datetime('now','-3 days'), datetime('now','-15 days')
	FROM movies m WHERE m.poster_path IS NOT NULL ORDER BY m.tmdb_id LIMIT 1 OFFSET 3;

INSERT INTO request_notifications (id, user_id, request_id, event, payload, read_at, created_at)
	VALUES ('seed-notif-admin-pending', '$ADMIN_ID', 'seed-req-pending-movie', 'request_pending',
		'{"title":"Fixture pending movie","mediaType":"movie"}', NULL, datetime('now','-2 days'));
INSERT INTO request_notifications (id, user_id, request_id, event, payload, read_at, created_at)
	VALUES ('seed-notif-viewer-fulfilled', 'seed-test-viewer', 'seed-req-fulfilled', 'request_fulfilled',
		'{"title":"Fixture fulfilled series","mediaType":"series"}', NULL, datetime('now','-2 days'));
SQL

echo "Test database ready: $DEST_DIR/cinephage.db"
echo "  Logins:   your admin username / $TEST_PASSWORD   ·   qatester / $TEST_PASSWORD"
echo "  Run:      DATA_DIR=$DEST_DIR npm run dev"
echo "  Grabs:    impossible (download clients + indexers disabled)"
