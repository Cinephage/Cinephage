using System;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Cinephage.Plugin.Jellyfin;

/// <summary>
/// Cinephage's Jellyfin plugin. Cinephage owns acquisition and filing; Jellyfin
/// owns playback. The plugin exists so Jellyfin can play the shortcut files
/// Cinephage writes (audio .strm today) instead of reading their URL as text.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Cinephage";

    public override Guid Id => Guid.Parse("d912b3f3-fc4c-4c74-90e1-678616b8fe9f");

    public override string Description =>
        "Lets Jellyfin play the media shortcuts Cinephage writes into your library.";
}

/// <summary>
/// No settings yet; Jellyfin requires a configuration type for a plugin.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
}
