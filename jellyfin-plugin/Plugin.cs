using System;
using System.Collections.Generic;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Cinephage.Plugin.Jellyfin;

/// <summary>
/// The Cinephage bridge inside Jellyfin. Cinephage owns acquisition and filing;
/// Jellyfin owns playback. The bridge starts with audio shortcut playback and
/// is the plugin future Cinephage integrations ship through.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
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
        "Connects Jellyfin to Cinephage. Plays Cinephage library shortcuts today; more Cinephage integrations will follow.";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "Cinephage",
                DisplayName = "Cinephage",
                EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html"
            }
        };
    }
}

/// <summary>
/// No settings yet; Jellyfin requires a configuration type for a plugin.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
}
