/**
 * Hand a URL to the browser the person actually uses.
 *
 * `shell.openExternal` is the platform's own mechanism — LaunchServices on
 * macOS, ShellExecute on Windows, xdg-open on Linux — so it is always tried
 * first. What it cannot promise is delivery: it reports that the request was
 * accepted, not that a window appeared. When it fails outright, each platform
 * gets its own explicit command rather than a silent nothing.
 *
 * The result names the mechanism that ran so a caller can say what happened
 * instead of claiming a browser opened.
 */
export type ExternalOpenMechanism = 'system' | 'open' | 'open-location' | 'start' | 'xdg-open' | 'gio' | 'failed'

export type ExternalOpenResult = { opened: boolean, mechanism: ExternalOpenMechanism, error?: string }

export type ExternalOpenDependencies = {
  platform?: NodeJS.Platform
  /** The host's own opener, normally Electron's `shell.openExternal`. */
  openExternal: (url: string) => Promise<void>
  /** Starts one command and resolves when it exits zero. */
  run: (command: string, args: string[]) => Promise<void>
}

export async function openInSystemBrowser(url: string, dependencies: ExternalOpenDependencies): Promise<ExternalOpenResult> {
  const platform = dependencies.platform || process.platform
  try {
    await dependencies.openExternal(url)
    return { opened: true, mechanism: 'system' }
  } catch (error) {
    // Fall through to what this platform uses when its own API is unavailable.
    const attempt = await fallback(url, platform, dependencies.run)
    return attempt ?? { opened: false, mechanism: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

async function fallback(url: string, platform: NodeJS.Platform, run: ExternalOpenDependencies['run']): Promise<ExternalOpenResult | undefined> {
  const commands: Array<{ mechanism: ExternalOpenMechanism, command: string, args: string[] }> = platform === 'darwin'
    ? [
        { mechanism: 'open', command: '/usr/bin/open', args: [url] },
        // Driving the default browser by its bundle identifier is the one route
        // that still works when the system's own opener is unresponsive.
        { mechanism: 'open-location', command: '/usr/bin/osascript', args: ['-e', `open location "${url}"`] },
      ]
    : platform === 'win32'
      // `start` is a cmd builtin, and its first argument is the window title.
      ? [{ mechanism: 'start', command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] }]
      : [
          { mechanism: 'xdg-open', command: 'xdg-open', args: [url] },
          { mechanism: 'gio', command: 'gio', args: ['open', url] },
        ]
  let last: ExternalOpenResult | undefined
  for (const attempt of commands) {
    try {
      await run(attempt.command, attempt.args)
      return { opened: true, mechanism: attempt.mechanism }
    } catch (error) {
      last = { opened: false, mechanism: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
  }
  return last
}
