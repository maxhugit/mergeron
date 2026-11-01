/** A catalog is either local or remote; never invent a filesystem path for a remote plugin. */
export type PluginKey = { pluginName: string } & (
  | { marketplacePath: string; remoteMarketplaceName?: never }
  | { remoteMarketplaceName: string; marketplacePath?: never }
);
export function pluginReference(
  marketplace: { path: string | null; name: string },
  pluginName: string,
): PluginKey {
  return marketplace.path
    ? { marketplacePath: marketplace.path, pluginName }
    : { remoteMarketplaceName: marketplace.name, pluginName };
}
