# Episode-pointer season packs

How a RuTracker/Kinozal "living" season pack is turned into a file selection, and
what else reads the result. Written because the same grab touches indexer search,
the grab handler, two download clients, the queue table and the importer — the
map is not obvious from any single file.

## The cause the design answers

Cinephage treated a season pack as a static snapshot and a pointer grab as a
single-file download: the handler selected the one episode that triggered the
search and set every other file in the torrent to priority 0. On RuTracker a
season is one topic that is re-created as episodes air, so a pack can already
contain the six earlier episodes that are also missing and monitored. The grab
downloaded 1 of 7 for that reason — not because the pack was wrong.

The rule the code now enforces: **a pointer grab selects every missing,
monitored, aired episode the pack actually contains, and nothing else.**

## Modules

| Module | Responsibility | May import |
|---|---|---|
| `downloads/episode-pointer.ts` | Pure matching: release title/GUID → pointer target; file paths → wanted file indices. No DB, no client. | nothing project-specific |
| `downloads/episode-pack-scope.ts` | The only I/O part: which episodes of the season are wanted right now (monitored, missing, aired, not queued). | `db`, `types/queue` |
| `downloads/episode-pack-selection.ts` | Composes the two above into one selection + episode-id list; enforces the triggering-episode invariant. | both |
| `downloads/handlers/TorrentHandler.ts` | Orchestration: resolve → client call → queue row → duplicate extension. | pack selection, `DownloadClientManager`, `DownloadMonitorService` |
| `downloadClients/core/interfaces.ts` | `IDownloadClient.extendFileSelection?()` — optional because only per-file clients can implement it. | — |
| `downloadClients/qbittorrent/*`, `transmission/*` | Translate indices/paths into client-specific file priorities. | core interfaces |
| `downloadClients/monitoring/DownloadMonitorService.ts` | Persists the episode scope on the queue row; `extendQueueItemEpisodes()` merges a later extension. | queue schema |
| `library/aired-episodes.ts` | The one definition of "aired" (`airDate` non-empty and `<= today`) plus the season id/count queries. | `db` |
| `indexers/search/SearchOrchestrator.ts` | Decides whether a pack is *complete enough* to grab for a season-only search. | indexer parser, `library/aired-episodes` |

## Flow

```
monitoring search (season-only)
  └─ SearchOrchestrator.filterBySeasonEpisode
       ├─ seasonEpisodeCount      TMDB announced total
       ├─ airedEpisodeCount       library/aired-episodes.ts (airDate <= today)   (new)
       └─ isCompletedRuTrackerSeasonPack
            accept iff covered range is a contiguous 1..N and
            N == announced total  OR  N >= aired total

grab
  └─ TorrentHandler.handle
       ├─ parseEpisodePointerFromGuid/Title        → target (season, episode, token)
       └─ resolveEpisodePackSelection
            ├─ [automatic only] resolveEpisodePackScope → episode ids + numbers
            ├─ buildEpisodePointerFileSelection        → fileIndices, matchedEpisodes, selectedSize
            └─ returns selection + matched episode ids
       ├─ client.addDownload(fileSelection)        → qBittorrent / Transmission priorities
       └─ downloadMonitor.addToQueue(episodeIds = matched episodes, size = selectedSize)

duplicate add (same infoHash already in client)
  └─ client.extendFileSelection(existing, new files)
       └─ downloadMonitor.extendQueueItemEpisodes(existing, new episode ids, size)

poll → import
  └─ import maps queueItem.episodeIds → episodes → files
```

## Consumers of the queue row

`download_queue.episode_ids` is read by the importer and by per-episode occupancy
checks. That is why a multi-episode grab must write the **whole** selected set,
not just the triggering episode: a row that claims one episode while seven files
download makes occupancy lie and the importer skip six files.

`download_queue.size` is the selected-file total for a pointer grab
(`shouldPreservePointerSize` in `DownloadMonitorService` keeps it from being
overwritten by the client's whole-torrent size).

## Invariants

1. The triggering episode must be inside the selection; a pack that does not
   contain it fails the grab rather than downloading a partial set.
2. Scope is resolved only for automatic grabs; interactive grabs keep
   single-episode semantics.
3. Scope never includes an episode with a file, an unmonitored episode, an
   episode that has not aired, or one covered by an active queue row.
4. Matching is pure and deterministic: same paths + same targets = same indices.
5. A client that cannot extend a selection falls back to the explicit
   "remove the existing torrent and retry" error — never a silent success.

## Known gaps (not fixed here)

- **Post-import extension is refused by design.** If the queue row already
  imported (`imported` / `seeding-imported`), `extendQueueItemEpisodes` returns
  null and the handler surfaces the retry error. Re-selecting files on an
  imported row would download them and never import them.
- **Transmission ignores `filePaths`.** It trusts the indices from the parsed
  `.torrent`; qBittorrent validates both. An index mismatch on Transmission
  would select the wrong file silently.
- **`S01E100` does not parse.** `parsePointerToken` requires exactly two digits
  per number; long-running anime seasons fall back to non-pointer handling.
- `SearchOrchestrator.ts` (3.6k lines) and `DownloadMonitorService.ts` (5.1k
  lines) are pre-existing god-files. New logic was kept out of them; splitting
  them is its own change.
