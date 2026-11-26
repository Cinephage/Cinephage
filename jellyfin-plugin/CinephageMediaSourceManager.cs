using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.MediaInfo;
using Microsoft.Extensions.Logging;

namespace Cinephage.Plugin.Jellyfin;

/// <summary>
/// Resolves playback for audio items whose file is a .strm shortcut.
///
/// Jellyfin's shortcut handling is video-only: an audio item keeps the text file
/// as its playback source, so clients receive the URL text. This decorator reads
/// the shortcut target, points the source at it, and shapes the source so the
/// server proxies the stream to the client (the stream URL, including its API
/// key, never reaches the client).
/// </summary>
public sealed class CinephageMediaSourceManager : IMediaSourceManager
{
    private readonly IMediaSourceManager _inner;
    private readonly IFileSystem _fileSystem;
    private readonly ILogger<CinephageMediaSourceManager> _logger;
    private readonly ConcurrentDictionary<Guid, byte> _backgroundProbes = new();

    public CinephageMediaSourceManager(
        IMediaSourceManager inner,
        IFileSystem fileSystem,
        ILogger<CinephageMediaSourceManager> logger)
    {
        _inner = inner;
        _fileSystem = fileSystem;
        _logger = logger;
        _logger.LogInformation("Cinephage: audio shortcut support active");
    }

    public async Task<IReadOnlyList<MediaSourceInfo>> GetPlaybackMediaSources(
        BaseItem item,
        User user,
        bool allowMediaProbe,
        bool enablePathSubstitution,
        CancellationToken cancellationToken)
    {
        EnsureShortcutPath(item);

        // Probing an HTTP audio stream inline delays the first play by seconds
        // and the web client asks for sources several times per play. Play
        // immediately with a synthetic stream, then probe in the background so
        // real media info lands for later plays.
        if (allowMediaProbe && IsAudioShortcut(item))
        {
            allowMediaProbe = false;

            if (!HasKnownAudioStream(item))
            {
                QueueBackgroundProbe(item);
            }
        }

        var sources = await _inner
            .GetPlaybackMediaSources(item, user, allowMediaProbe, enablePathSubstitution, cancellationToken)
            .ConfigureAwait(false);

        FixSources(item, sources);
        return sources;
    }

    public IReadOnlyList<MediaSourceInfo> GetStaticMediaSources(
        BaseItem item,
        bool enablePathSubstitution,
        User? user = null)
    {
        EnsureShortcutPath(item);

        var sources = _inner.GetStaticMediaSources(item, enablePathSubstitution, user);
        FixSources(item, sources);
        return sources;
    }

    public async Task<MediaSourceInfo> GetMediaSource(
        BaseItem item,
        string mediaSourceId,
        string liveStreamId,
        bool enablePathSubstitution,
        CancellationToken cancellationToken)
    {
        EnsureShortcutPath(item);

        var source = await _inner
            .GetMediaSource(item, mediaSourceId, liveStreamId, enablePathSubstitution, cancellationToken)
            .ConfigureAwait(false);

        if (source is not null)
        {
            FixSources(item, new[] { source });
        }

        return source!;
    }

    private static bool IsAudioShortcut(BaseItem item)
        => item is Audio && StrmFile.IsStrm(item.Path);

    private void EnsureShortcutPath(BaseItem item)
    {
        if (!IsAudioShortcut(item))
        {
            return;
        }

        // Always re-read: Jellyfin may already carry a ShortcutPath captured
        // before the shortcut was rewritten with fresh hints.
        var target = StrmFile.ReadTarget(item.Path);
        if (string.IsNullOrWhiteSpace(target))
        {
            _logger.LogWarning("Cinephage: no target found in {Path}", item.Path);
            return;
        }

        if (string.Equals(item.ShortcutPath, target, StringComparison.Ordinal))
        {
            return;
        }

        item.IsShortcut = true;
        item.ShortcutPath = target;
        _logger.LogDebug("Cinephage: shortcut {Id} -> {Target}", item.Id, Sanitize(target));
    }

    private void QueueBackgroundProbe(BaseItem item)
    {
        if (!_backgroundProbes.TryAdd(item.Id, 0))
        {
            return;
        }

        _logger.LogInformation("Cinephage: probing stream info for {Id} in the background", item.Id);

        _ = Task.Run(async () =>
        {
            try
            {
                await item.RefreshMetadata(
                    new MetadataRefreshOptions(new DirectoryService(_fileSystem))
                    {
                        EnableRemoteContentProbe = true,
                        MetadataRefreshMode = MetadataRefreshMode.FullRefresh
                    },
                    CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Cinephage: background probe failed for {Id}", item.Id);
            }
            finally
            {
                _backgroundProbes.TryRemove(item.Id, out _);
            }
        });
    }

    private bool HasKnownAudioStream(BaseItem item)
    {
        try
        {
            foreach (var stream in _inner.GetMediaStreams(item.Id))
            {
                if (stream?.Type == MediaStreamType.Audio)
                {
                    return true;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Cinephage: could not read stored streams for {Id}", item.Id);
        }

        return false;
    }

    private void FixSources(BaseItem item, IEnumerable<MediaSourceInfo>? sources)
    {
        if (!IsAudioShortcut(item) || sources is null)
        {
            return;
        }

        // Read the file, not item.ShortcutPath: the core can hand back a
        // shortcut path captured before the .strm was rewritten. The file is
        // the source of truth.
        var target = StrmFile.ReadTarget(item.Path);
        if (string.IsNullOrWhiteSpace(target))
        {
            target = item.ShortcutPath;
        }

        if (string.IsNullOrWhiteSpace(target))
        {
            return;
        }

        // Mirrors Jellyfin's rule for video shortcuts: a .strm may reference a
        // URL, never a local path (that would be an arbitrary file read).
        if (_inner.GetPathProtocol(target) == MediaProtocol.File)
        {
            _logger.LogWarning("Cinephage: refusing local path in {Path}", item.Path);
            return;
        }

        var extension = GetUrlExtension(target);
        var hints = ReadHints(target);

        foreach (var source in sources)
        {
            if (source is null)
            {
                continue;
            }

            try
            {
                // The core hands back a source it already resolved from its
                // cache on later plays (Protocol Http, with the URL captured
                // before the shortcut gained hints). The .strm on disk is the
                // source of truth, so rewrite every source of an audio
                // shortcut, not only the File-protocol one.
                RewriteSource(source, target, extension, hints);
            }
            catch (Exception ex)
            {
                // A failure here must not take the whole library's playback
                // down; leave the source as the core built it.
                _logger.LogWarning(ex, "Cinephage: could not rewrite source {Id}", source.Id);
            }
        }
    }

    private void RewriteSource(
        MediaSourceInfo source,
        string target,
        string? extension,
        StreamHints hints)
    {
        source.Path = target;
        source.Protocol = MediaProtocol.Http;
        // false keeps the server in the loop: the universal audio endpoint then
        // fetches and forwards the stream instead of 302-redirecting the client
        // to a URL that carries Cinephage's API key.
        source.IsRemote = false;
        source.Size = null;

        if (string.Equals(source.Container, "strm", StringComparison.OrdinalIgnoreCase))
        {
            source.Container = null;
        }

        var container = string.IsNullOrEmpty(source.Container)
            ? hints.Container ?? extension ?? "mp3"
            : source.Container;
        source.Container = container;

        if (!HasAudioStream(source))
        {
            var streams = source.MediaStreams is null
                ? new List<MediaStream>()
                : new List<MediaStream>(source.MediaStreams);

            streams.Add(new MediaStream
            {
                Type = MediaStreamType.Audio,
                Index = streams.Count,
                Codec = hints.Codec ?? GuessAudioCodec(container)
            });

            source.MediaStreams = streams;
        }

        // The shortcut's hints let the first play behave like a finite file
        // instead of a live stream: Jellyfin shows a duration and the client
        // can seek before any probe has run. A runtime the core already knows
        // wins over the hint.
        if ((!source.RunTimeTicks.HasValue || source.RunTimeTicks.Value <= 0)
            && hints.DurationSeconds is > 0 and < 86400)
        {
            source.RunTimeTicks = (long)(hints.DurationSeconds.Value * TimeSpan.TicksPerSecond);
        }

        if (!source.RunTimeTicks.HasValue || source.RunTimeTicks.Value <= 0)
        {
            source.IsInfiniteStream = true;
            source.RunTimeTicks = null;
        }
        else
        {
            source.IsInfiniteStream = false;
        }

        source.SupportsDirectPlay = true;
        source.SupportsDirectStream = true;

        _logger.LogDebug(
            "Cinephage: source {Id} -> {Target} (container={Container}, infinite={Infinite})",
            source.Id,
            Sanitize(target),
            source.Container,
            source.IsInfiniteStream);
    }

    private static bool HasAudioStream(MediaSourceInfo source)
    {
        if (source.MediaStreams is null)
        {
            return false;
        }

        foreach (var stream in source.MediaStreams)
        {
            if (stream?.Type == MediaStreamType.Audio)
            {
                return true;
            }
        }

        return false;
    }

    private static string Sanitize(string target)
    {
        var queryIndex = target.IndexOf('?', StringComparison.Ordinal);
        return queryIndex >= 0 ? target[..queryIndex] + "?..." : target;
    }

    /// <summary>
    /// Optional hints Cinephage writes into a music shortcut's query string.
    /// They describe a finite provider stream so the first play needs no probe.
    /// </summary>
    private readonly record struct StreamHints(
        string? Container,
        string? Codec,
        double? DurationSeconds);

    private static StreamHints ReadHints(string target)
    {
        var container = QueryValue(target, "cp_container");
        var codec = QueryValue(target, "cp_codec");
        var rawDuration = QueryValue(target, "cp_duration");

        double? duration = null;
        if (!string.IsNullOrEmpty(rawDuration)
            && double.TryParse(rawDuration, NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
            && seconds > 0)
        {
            duration = seconds;
        }

        return new StreamHints(
            string.IsNullOrWhiteSpace(container) ? null : container.Trim().ToLowerInvariant(),
            string.IsNullOrWhiteSpace(codec) ? null : codec.Trim().ToLowerInvariant(),
            duration);
    }

    private static string? QueryValue(string url, string key)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return null;
        }

        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = pair.IndexOf('=');
            var name = separator >= 0 ? pair[..separator] : pair;
            if (!string.Equals(Uri.UnescapeDataString(name), key, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            return separator >= 0 ? Uri.UnescapeDataString(pair[(separator + 1)..]) : string.Empty;
        }

        return null;
    }

    private static string? GetUrlExtension(string target)
    {
        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri))
        {
            return null;
        }

        var extension = System.IO.Path.GetExtension(uri.AbsolutePath);
        if (string.IsNullOrEmpty(extension) || extension.Length < 2)
        {
            return null;
        }

        return extension.TrimStart('.').ToLowerInvariant();
    }

    private static string GuessAudioCodec(string? extension)
        => extension switch
        {
            "mp3" => "mp3",
            "aac" or "m4a" or "m4b" => "aac",
            "flac" => "flac",
            "ogg" or "oga" => "vorbis",
            "opus" => "opus",
            "wav" => "pcm_s16le",
            "wma" => "wmav2",
            _ => "mp3"
        };

    // ------------------------------------------------------------------
    //  Unchanged members: delegate to the core implementation.
    // ------------------------------------------------------------------

    public void AddParts(IEnumerable<IMediaSourceProvider> providers)
        => _inner.AddParts(providers);

    public IReadOnlyList<MediaStream> GetMediaStreams(Guid itemId)
        => _inner.GetMediaStreams(itemId);

    public IReadOnlyList<MediaStream> GetMediaStreams(MediaStreamQuery query)
        => _inner.GetMediaStreams(query);

    public IReadOnlyList<MediaAttachment> GetMediaAttachments(Guid itemId)
        => _inner.GetMediaAttachments(itemId);

    public IReadOnlyList<MediaAttachment> GetMediaAttachments(MediaAttachmentQuery query)
        => _inner.GetMediaAttachments(query);

    public Task<LiveStreamResponse> OpenLiveStream(LiveStreamRequest request, CancellationToken cancellationToken)
        => _inner.OpenLiveStream(request, cancellationToken);

    public Task<Tuple<LiveStreamResponse, IDirectStreamProvider>> OpenLiveStreamInternal(
        LiveStreamRequest request,
        CancellationToken cancellationToken)
        => _inner.OpenLiveStreamInternal(request, cancellationToken);

    public Task<MediaSourceInfo> GetLiveStream(string id, CancellationToken cancellationToken)
        => _inner.GetLiveStream(id, cancellationToken);

    public Task<Tuple<MediaSourceInfo, IDirectStreamProvider>> GetLiveStreamWithDirectStreamProvider(
        string id,
        CancellationToken cancellationToken)
        => _inner.GetLiveStreamWithDirectStreamProvider(id, cancellationToken);

    public ILiveStream GetLiveStreamInfo(string id)
        => _inner.GetLiveStreamInfo(id);

    public ILiveStream GetLiveStreamInfoByUniqueId(string uniqueId)
        => _inner.GetLiveStreamInfoByUniqueId(uniqueId);

    public Task<IReadOnlyList<MediaSourceInfo>> GetRecordingStreamMediaSources(
        ActiveRecordingInfo info,
        CancellationToken cancellationToken)
        => _inner.GetRecordingStreamMediaSources(info, cancellationToken);

    public Task CloseLiveStream(string id)
        => _inner.CloseLiveStream(id);

    public Task<MediaSourceInfo> GetLiveStreamMediaInfo(string id, CancellationToken cancellationToken)
        => _inner.GetLiveStreamMediaInfo(id, cancellationToken);

    public bool SupportsDirectStream(string path, MediaProtocol protocol)
        => _inner.SupportsDirectStream(path, protocol);

    public MediaProtocol GetPathProtocol(string path)
        => _inner.GetPathProtocol(path);

    public void SetDefaultAudioAndSubtitleStreamIndices(BaseItem item, MediaSourceInfo source, User user)
        => _inner.SetDefaultAudioAndSubtitleStreamIndices(item, source, user);

    public Task AddMediaInfoWithProbe(
        MediaSourceInfo mediaSource,
        bool isAudio,
        string cacheKey,
        bool addProbeDelay,
        bool isLiveStream,
        CancellationToken cancellationToken)
        => _inner.AddMediaInfoWithProbe(mediaSource, isAudio, cacheKey, addProbeDelay, isLiveStream, cancellationToken);
}
