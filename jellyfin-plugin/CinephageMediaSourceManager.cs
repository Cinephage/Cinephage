using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
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
        if (!IsAudioShortcut(item) || !string.IsNullOrWhiteSpace(item.ShortcutPath))
        {
            return;
        }

        var target = StrmFile.ReadTarget(item.Path);
        if (string.IsNullOrWhiteSpace(target))
        {
            _logger.LogWarning("Cinephage: no target found in {Path}", item.Path);
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

        var target = item.ShortcutPath;
        if (string.IsNullOrWhiteSpace(target))
        {
            target = StrmFile.ReadTarget(item.Path);
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

        foreach (var source in sources)
        {
            if (source is null
                || source.Protocol != MediaProtocol.File
                || !StrmFile.IsStrm(source.Path))
            {
                continue;
            }

            try
            {
                RewriteSource(source, target, extension);
            }
            catch (Exception ex)
            {
                // A failure here must not take the whole library's playback
                // down; leave the source as the core built it.
                _logger.LogWarning(ex, "Cinephage: could not rewrite source {Id}", source.Id);
            }
        }
    }

    private void RewriteSource(MediaSourceInfo source, string target, string? extension)
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

        if (string.IsNullOrEmpty(source.Container))
        {
            source.Container = extension ?? "mp3";
        }

        if (!HasAudioStream(source))
        {
            var streams = source.MediaStreams is null
                ? new List<MediaStream>()
                : new List<MediaStream>(source.MediaStreams);

            streams.Add(new MediaStream
            {
                Type = MediaStreamType.Audio,
                Index = streams.Count,
                Codec = GuessAudioCodec(extension)
            });

            source.MediaStreams = streams;
        }

        if (!source.RunTimeTicks.HasValue || source.RunTimeTicks.Value <= 0)
        {
            source.IsInfiniteStream = true;
            source.RunTimeTicks = null;
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
