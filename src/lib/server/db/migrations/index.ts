import type { MigrationDefinition } from '../migration-helpers.js';
import { migration_v002 } from './002-add-profile-tables.js';
import { migration_v003 } from './003-add-root-folders-read-only.js';
import { migration_v004 } from './004-fix-scoring-profile-references.js';
import { migration_v005 } from './005-add-root-folders-preserve-symlinks.js';
import { migration_v006 } from './006-add-nzb-streaming-tables.js';
import { migration_v007 } from './007-add-nzb-extraction-columns.js';
import { migration_v008 } from './008-fix-nzb-mounts-check-constraint.js';
import { migration_v009 } from './009-remove-quality-presets.js';
import { migration_v010 } from './010-flag-broken-series-metadata.js';
import { migration_v011 } from './011-add-download-client-temp-paths.js';
import { migration_v012 } from './012-add-media-browser-servers.js';
import { migration_v013 } from './013-remove-live-tv-v1.js';
import { migration_v014 } from './014-add-live-tv-external-api.js';
import { migration_v015 } from './015-remove-live-tv-epg-cache.js';
import { migration_v016 } from './016-add-live-tv-stream-health.js';
import { migration_v017 } from './017-add-live-tv-epg-xmltv.js';
import { migration_v018 } from './018-add-epg-performance-indexes.js';
import { migration_v019 } from './019-add-epg-search-indexes.js';
import { migration_v020 } from './020-add-daddyhd-provider.js';
import { migration_v021 } from './021-add-live-tv-cached-server.js';
import { migration_v022 } from './022-remove-live-tv-v2.js';
import { migration_v023 } from './023-add-stalker-accounts.js';
import { migration_v024 } from './024-add-stalker-channel-caching.js';
import { migration_v025 } from './025-add-channel-lineup-tables.js';
import { migration_v026 } from './026-add-epg-programs.js';
import { migration_v027 } from './027-add-channel-lineup-backups.js';
import { migration_v028 } from './028-drop-old-live-tv-settings.js';
import { migration_v029 } from './029-clean-break-live-tv.js';
import { migration_v030 } from './030-add-stalker-device-params.js';
import { migration_v031 } from './031-add-portal-scanner-tables.js';
import { migration_v032 } from './032-add-stalker-epg-tracking.js';
import { migration_v033 } from './033-add-epg-source-override.js';
import { migration_v034 } from './034-add-download-client-url-base.js';
import { migration_v035 } from './035-add-download-client-mount-mode.js';
import { migration_v036 } from './036-add-nzb-segment-cache.js';
import { migration_v037 } from './037-add-stream-url-type.js';
import { migration_v038 } from './038-add-alternate-titles.js';
import { migration_v039 } from './039-add-release-group-columns.js';
import { migration_v040 } from './040-add-captcha-solver-settings.js';
import { migration_v041 } from './041-add-root-folders-default-monitored.js';
import { migration_v042 } from './042-add-smart-list-external-source-support.js';
import { migration_v043 } from './043-add-smart-list-preset-fields.js';
import { migration_v044 } from './044-add-info-hash-to-file-tables.js';
import { migration_v045 } from './045-add-activities-table.js';
import { migration_v046 } from './046-add-activity-details-table.js';
import { migration_v047 } from './047-add-task-settings-table.js';
import { migration_v048 } from './048-dedupe-episode-files-and-add-unique-path-index.js';
import { migration_v049 } from './049-backfill-orphaned-download-history-to-removed.js';
import { migration_v050 } from './050-livetv-fresh-start-multiprovider.js';
import { migration_v051 } from './051-fix-lineup-foreign-keys.js';
import { migration_v052 } from './052-fix-epg-programs-schema.js';
import { migration_v053 } from './053-add-iptv-org-config-column.js';
import { migration_v054 } from './054-add-indexer-cookies-columns.js';
import { migration_v055 } from './055-add-download-client-health-columns.js';
import { migration_v056 } from './056-reserved-better-auth-refactor-v56.js';
import { migration_v057 } from './057-reserved-better-auth-refactor-v57.js';
import { migration_v058 } from './058-reserved-better-auth-refactor-v58.js';
import { migration_v059 } from './059-reserved-better-auth-refactor-v59.js';
import { migration_v060 } from './060-add-user-api-key-secrets-table.js';
import { migration_v061 } from './061-rename-live-tv-to-media-streaming-api-key.js';
import { migration_v062 } from './062-add-user-role-column.js';
import { migration_v063 } from './063-repair-better-auth-schema.js';
import { migration_v064 } from './064-ensure-bootstrap-user-is-admin.js';
import { migration_v065 } from './065-migrate-apikey-schema-v1-5.js';
import { migration_v066 } from './066-fix-apikey-schema-v1-5-stuck.js';
import { migration_v067 } from './067-add-rate-limit-id-column.js';
import { migration_v068 } from './068-add-edition-to-episode-files.js';
import { migration_v069 } from './069-add-download-history-indexes.js';
import { migration_v070 } from './070-drop-unused-activities-tables.js';
import { migration_v071 } from './071-add-download-queue-tombstones-table.js';
import { migration_v072 } from './072-add-adaptive-subtitle-searching-columns.js';
import { migration_v073 } from './073-allow-plex-media-browser-servers.js';
import { migration_v074 } from './074-consolidate-nzb-mount-clients-into-sab-mount-mode.js';
import { migration_v075 } from './075-add-language-column-to-user-table.js';
import { migration_v076 } from './076-add-root-folders-media-sub-type.js';
import { migration_v077 } from './077-add-libraries-table-and-media-links.js';
import { migration_v078 } from './078-backfill-existing-media-to-system-libraries.js';
import { migration_v079 } from './079-migrate-custom-format-audio-conditions.js';
import { migration_v080 } from './080-built-in-profile-score-overrides.js';
import { migration_v081 } from './081-unify-scoring-profile-architecture.js';
import { migration_v082 } from './082-add-media-server-stats-tables.js';
import { migration_v083 } from './083-add-movie-collection-columns.js';
import { migration_v084 } from './084-add-release-date-columns.js';
import { migration_v085 } from './085-add-metadata-provider-columns.js';
import { migration_v086 } from './086-add-movie-metadata-provider-columns.js';
import { migration_v087 } from './087-add-blocked-media-table.js';
import { migration_v088 } from './088-add-root-folder-scan-filters.js';
import { migration_v089 } from './089-add-blocked-keywords-table.js';
import { migration_v090 } from './090-add-library-jobs.js';
import { migration_v091 } from './091-add-download-release-date.js';
import { migration_v092 } from './092-split-release-date-columns.js';
import { migration_v093 } from './093-add-indexer-upstream-enabled.js';
import { migration_v094 } from './094-add-indexer-orphaned.js';
import { migration_v095 } from './095-drop-provider-choice-columns.js';
import { migration_v096 } from './096-add-adult-columns.js';
import { migration_v097 } from './097-add-episode-group-id.js';
import { migration_v098 } from './098-add-indexer-categories.js';
import { migration_v100 } from './100-add-scoring-profile-prevent-downgrades.js';
import { migration_v101 } from './101-add-cinephage-api-tables.js';
import { migration_v102 } from './102-add-indexers-is-built-in.js';
import { migration_v103 } from './103-migrate-streaming-settings.js';
import { migration_v104 } from './104-drop-indexer-definitions-table.js';
import { migration_v105 } from './105-add-delay-profile-assignment.js';
import { migration_v106 } from './106-add-required-formats-to-scoring-profiles.js';
import { migration_v107 } from './107-migrate-required-formats-to-entries.js';
import { migration_v108 } from './108-add-download-queue-stalled-since.js';
import { migration_v109 } from './109-add-stalled-orphan-tracking-table.js';
import { migration_v110 } from './110-add-storage-items-tables.js';
import { migration_v111 } from './111-add-rename-history.js';
import { migration_v112 } from './112-add-pattern-recognition.js';
import { migration_v113 } from './113-add-resolution-categories.js';
import { migration_v114 } from './114-add-quality-scaffolding.js';
import { migration_v115 } from './115-add-scan-mode.js';
import { migration_v116 } from './116-add-duplicate-detection.js';
import { migration_v117 } from './117-add-quality-profile-to-delay-profiles.js';
import { migration_v118 } from './118-add-scan-mode-to-delay-profiles.js';
import { migration_v119 } from './119-backfill-release-group-from-title.js';
import { migration_v120 } from './120-migrate-prowlarr-indexers-to-native.js';
import { migration_v121 } from './121-migrate-jackett-indexers-to-native.js';
import { migration_v122 } from './122-remove-quality-scaffolding-defaults.js';
import { migration_v123 } from './123-add-movies-desired-qualities.js';
import { migration_v124 } from './124-add-subtitles-movie-file-id.js';
import { migration_v125 } from './125-add-debrid-client-columns.js';
import { migration_v126 } from './126-add-metadata-language-overrides.js';
import { migration_v127 } from './127-add-cinephage-api-identity-auto-sync.js';
import { migration_v128 } from './128-add-diagnostic-report-tables.js';
import { migration_v129 } from './129-add-rejected-releases-reason-columns.js';
import { migration_v130 } from './130-add-rejected-releases-grab-fields.js';
import { migration_v131 } from './131-purge-orphaned-unmatched-files.js';
import { migration_v132 } from './132-add-qbittorrent-sequential-download.js';
import { migration_v133 } from './133-backfill-download-queue-info-hashes.js';
import { migration_v134 } from './134-add-download-history-info-hash.js';
import { migration_v135 } from './135-dedupe-active-download-queue.js';
import { migration_v136 } from './136-add-storage-items-file-id-indexes.js';
import { migration_v137 } from './137-add-debrid-content-type-columns.js';
import { migration_v138 } from './138-add-arr-id-mappings.js';
import { migration_v139 } from './139-add-arr-notification-configs.js';
import { migration_v140 } from './140-language-system-reset.js';
import { migration_v141 } from './141-subtitle-search-state-and-episode-path-base.js';
import { migration_v142 } from './142-allow-anilist-mal-alternate-title-sources.js';
import { migration_v143 } from './143-media-server-language-normalization.js';
import { migration_v144 } from './144-language-settings-prefer-original-title.js';
import { migration_v145 } from './145-drop-deprecated-adaptive-subtitle-columns.js';
import { migration_v146 } from './146-subtitle-requirement-overrides.js';
import { migration_v147 } from './147-language-shortfall-flag.js';
import { migration_v148 } from './148-acquisition-intents-reservations.js';
import { migration_v149 } from './149-import-operations-journal.js';
import { migration_v150 } from './150-movie-files-path-unique.js';
import { migration_v151 } from './151-language-system-column-guards.js';
import { migration_v152 } from './152-drop-subtitle-settings.js';
import { migration_v153 } from './153-backfill-remove-after-import.js';
import { migration_v154 } from './154-library-jobs-acknowledged.js';
import { migration_v155 } from './155-indexer-rate-limit-override.js';
import { migration_v156 } from './156-indexer-status-disabled-reason.js';
import { migration_v157 } from './157-user-media-server-links.js';
import { migration_v158 } from './158-user-preferences.js';
import { migration_v159 } from './159-encrypt-media-browser-api-keys.js';
import { migration_v160 } from './160-request-system.js';
import { migration_v161 } from './161-encrypt-credentials-at-rest.js';
import { migration_v162 } from './162-session-last-active.js';
import { migration_v163 } from './163-repair-orphaned-episode-seasons.js';
import { migration_v164 } from './164-transfer-mode.js';
import { migration_v165 } from './165-unmatched-origin.js';
import { migration_v166 } from './166-scoring-profile-allowed-indexers.js';
import { migration_v167 } from './167-add-cinephage-live-channel-data.js';

export const MIGRATIONS: MigrationDefinition[] = [
	migration_v002,
	migration_v003,
	migration_v004,
	migration_v005,
	migration_v006,
	migration_v007,
	migration_v008,
	migration_v009,
	migration_v010,
	migration_v011,
	migration_v012,
	migration_v013,
	migration_v014,
	migration_v015,
	migration_v016,
	migration_v017,
	migration_v018,
	migration_v019,
	migration_v020,
	migration_v021,
	migration_v022,
	migration_v023,
	migration_v024,
	migration_v025,
	migration_v026,
	migration_v027,
	migration_v028,
	migration_v029,
	migration_v030,
	migration_v031,
	migration_v032,
	migration_v033,
	migration_v034,
	migration_v035,
	migration_v036,
	migration_v037,
	migration_v038,
	migration_v039,
	migration_v040,
	migration_v041,
	migration_v042,
	migration_v043,
	migration_v044,
	migration_v045,
	migration_v046,
	migration_v047,
	migration_v048,
	migration_v049,
	migration_v050,
	migration_v051,
	migration_v052,
	migration_v053,
	migration_v054,
	migration_v055,
	migration_v056,
	migration_v057,
	migration_v058,
	migration_v059,
	migration_v060,
	migration_v061,
	migration_v062,
	migration_v063,
	migration_v064,
	migration_v065,
	migration_v066,
	migration_v067,
	migration_v068,
	migration_v069,
	migration_v070,
	migration_v071,
	migration_v072,
	migration_v073,
	migration_v074,
	migration_v075,
	migration_v076,
	migration_v077,
	migration_v078,
	migration_v079,
	migration_v080,
	migration_v081,
	migration_v082,
	migration_v083,
	migration_v084,
	migration_v085,
	migration_v086,
	migration_v087,
	migration_v088,
	migration_v089,
	migration_v090,
	migration_v091,
	migration_v092,
	migration_v093,
	migration_v094,
	migration_v095,
	migration_v096,
	migration_v097,
	migration_v098,
	migration_v100,
	migration_v101,
	migration_v102,
	migration_v103,
	migration_v104,
	migration_v105,
	migration_v106,
	migration_v107,
	migration_v108,
	migration_v109,
	migration_v110,
	migration_v111,
	migration_v112,
	migration_v113,
	migration_v114,
	migration_v115,
	migration_v116,
	migration_v117,
	migration_v118,
	migration_v119,
	migration_v120,
	migration_v121,
	migration_v122,
	migration_v123,
	migration_v124,
	migration_v125,
	migration_v126,
	migration_v127,
	migration_v128,
	migration_v129,
	migration_v130,
	migration_v131,
	migration_v132,
	migration_v133,
	migration_v134,
	migration_v135,
	migration_v136,
	migration_v137,
	migration_v138,
	migration_v139,
	migration_v140,
	migration_v141,
	migration_v142,
	migration_v143,
	migration_v144,
	migration_v145,
	migration_v146,
	migration_v147,
	migration_v148,
	migration_v149,
	migration_v150,
	migration_v151,
	migration_v152,
	migration_v153,
	migration_v154,
	migration_v155,
	migration_v156,
	migration_v157,
	migration_v158,
	migration_v159,
	migration_v160,
	migration_v161,
	migration_v162,
	migration_v163,
	migration_v164,
	migration_v165,
	migration_v166,
	migration_v167
];
