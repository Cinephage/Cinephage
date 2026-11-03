# Third-Party Notices

Cinephage is licensed under the [GNU General Public License v3.0](LICENSE).

This document acknowledges the open-source projects that inspired Cinephage's design and architecture. **Cinephage is an original implementation** - no code was copied from these projects. However, we credit them for their influence on our approach.

## Inspiration Projects

### GPLv3 Licensed Projects

These projects use the same license as Cinephage:

| Project                                                      | License | Inspiration                                               |
| ------------------------------------------------------------ | ------- | --------------------------------------------------------- |
| [Radarr](https://github.com/Radarr/Radarr)                   | GPL-3.0 | Download management, monitoring system, quality logic     |
| [Sonarr](https://github.com/Sonarr/Sonarr)                   | GPL-3.0 | TV series handling, episode monitoring, season pack logic |
| [Prowlarr](https://github.com/Prowlarr/Prowlarr)             | GPL-3.0 | Indexer system, Cardigann YAML format, health tracking    |
| [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) | MIT     | Cloudflare bypass handling patterns                       |

### MIT Licensed Projects

These projects use permissive licenses compatible with GPLv3:

| Project                                           | License | Inspiration                    |
| ------------------------------------------------- | ------- | ------------------------------ |
| [Bazarr](https://github.com/morpheus65535/bazarr) | GPL-3.0 | Subtitle provider architecture |
| [Overseerr](https://github.com/sct/overseerr)     | MIT     | Modern UI/UX patterns          |
| [Seerr](https://github.com/seerr-team/seerr)      | MIT     | Request management UI patterns |

### Other Projects

| Project                                                    | License | Inspiration                        |
| ---------------------------------------------------------- | ------- | ---------------------------------- |
| [Flyx](https://github.com/Vynx-Velvet/Flyx-main)           | Unknown | Movie/TV discovery UI patterns     |
| [Dictionarry](https://github.com/Dictionarry-Hub/database) | Unknown | Quality scoring database structure |

## Runtime Dependencies

Cinephage uses the following npm packages. All are MIT licensed and compatible with GPLv3:

| Package         | License | Purpose                              |
| --------------- | ------- | ------------------------------------ |
| better-sqlite3  | MIT     | SQLite database driver               |
| cheerio         | MIT     | HTML parsing for indexer scraping    |
| crypto-js       | MIT     | Encryption utilities                 |
| fast-xml-parser | MIT     | XML parsing for Newznab feeds        |
| js-yaml         | MIT     | YAML parsing for indexer definitions |
| parse-torrent   | MIT     | Torrent file/magnet parsing          |
| adm-zip         | MIT     | ZIP file handling                    |
| @parcel/watcher | MIT     | File system watching                 |
| zod             | MIT     | Runtime type validation              |

## External Services

Cinephage integrates with these external services:

- **[TMDB](https://www.themoviedb.org/)** - Movie and TV metadata (requires API key, subject to TMDB terms)
- **[qBittorrent](https://www.qbittorrent.org/)** - Download client (GPL-2.0+)

## License Compatibility Note

Cinephage uses GPLv3 because:

1. Our primary inspirations (Radarr, Sonarr, Prowlarr) are GPLv3
2. GPLv3 ensures the project remains free and open source
3. All MIT-licensed dependencies and inspirations are compatible with GPLv3

This means:

- You can use, modify, and distribute Cinephage freely
- Any modifications must also be released under GPLv3
- You must provide source code when distributing

For the complete license text, see [LICENSE](LICENSE).
