using System;
using System.IO;

namespace Cinephage.Plugin.Jellyfin;

/// <summary>
/// Reads the target URL from a .strm shortcut: the first non-empty, non-comment
/// line, matching Jellyfin's own video shortcut format.
/// </summary>
internal static class StrmFile
{
    public static bool IsStrm(string? path)
        => !string.IsNullOrEmpty(path)
           && path.EndsWith(".strm", StringComparison.OrdinalIgnoreCase);

    public static string? ReadTarget(string? strmPath)
    {
        if (string.IsNullOrEmpty(strmPath))
        {
            return null;
        }

        try
        {
            foreach (var raw in File.ReadLines(strmPath))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith('#'))
                {
                    continue;
                }

                return line;
            }
        }
        catch (Exception)
        {
            // Unreadable or removed shortcut; the caller logs and leaves the
            // item alone so the rest of the library keeps playing.
        }

        return null;
    }
}
