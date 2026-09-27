import { PLUGIN_ASSET_SCHEME, type PreviewAssetSource } from './remote-preview.ts'

/**
 * A plugin's interface, served to whoever is showing it.
 *
 * A package is not a server, and a web view can only load an http origin, so the
 * tunnel serves one as the other — under the same scheme the desktop has always
 * served a plugin under. One name for one thing is what lets a session be pinned
 * to it without a translation table in between.
 *
 * The reader is injected because the content type is a fact about a file that
 * only the runtime that reads files knows: Electron answers with the extension's
 * own type rather than a table kept here, so a plugin does not have to declare
 * what a `.css` is and this does not have to guess.
 */
export type PluginAssetReader = (path: string) => Promise<{ contentType: string; body: Buffer } | undefined>

export function pluginAssetSource(assetPath: (pluginId: string, path: string) => string, readAsset: PluginAssetReader): PreviewAssetSource {
  return {
    matches: origin => origin.startsWith(PLUGIN_ASSET_SCHEME),
    async read(origin, path) {
      const pluginId = new URL(origin).hostname
      if (!pluginId) return undefined
      // What a plugin's own bridge reads — the channel it was opened with — is a
      // query, and a query is not part of a file's name.
      const asset = path.split(/[?#]/)[0]
      if (!asset) return undefined
      return readAsset(assetPath(pluginId, asset))
    },
  }
}
