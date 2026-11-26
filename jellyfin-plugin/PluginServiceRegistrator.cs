using System;
using System.Linq;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Cinephage.Plugin.Jellyfin;

/// <summary>
/// Wraps Jellyfin's own <see cref="IMediaSourceManager"/> with the Cinephage
/// decorator. Jellyfin applies plugin service registrations after its core
/// registrations, and the last registration of a service wins, so replacing the
/// descriptor makes the whole server use the decorator.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        var descriptor = serviceCollection.LastOrDefault(d =>
            d.ServiceType == typeof(IMediaSourceManager)
            && d.ImplementationType is not null);

        if (descriptor?.ImplementationType is null)
        {
            // Unknown server layout: leave the core untouched rather than
            // guessing at an internal type.
            return;
        }

        var innerType = descriptor.ImplementationType;

        serviceCollection.Remove(descriptor);
        serviceCollection.AddSingleton(innerType);
        serviceCollection.AddSingleton<IMediaSourceManager>(sp =>
            new CinephageMediaSourceManager(
                (IMediaSourceManager)sp.GetRequiredService(innerType),
                sp.GetRequiredService<MediaBrowser.Model.IO.IFileSystem>(),
                sp.GetRequiredService<ILogger<CinephageMediaSourceManager>>()));
    }
}
