/**
 * Host-owned OAuth client registrations.
 *
 * Authorization belongs to the host, not to a plugin: the desktop process runs
 * the loopback + PKCE flow, keeps the resulting tokens in the OS-encrypted
 * secret store, and reports only connection state back. A connector becomes
 * one-click when this build carries a registration — without one it keeps
 * asking the user for their own credential, which is the honest fallback rather
 * than a button that cannot work.
 *
 * Registrations come from the build environment and never from this repository,
 * because a committed client secret is a published one:
 *
 *   SHUN_GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com
 *   SHUN_GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-…
 *
 * `.env.release` supplies them for release builds (see RELEASING.md), and a
 * development build can export the same variables before `pnpm dev`. The build
 * bakes the values into the main bundle, so an installed build carries its
 * registration without reading the environment at runtime.
 *
 * The Google credential is not a secret in the usual sense. Google issues it for
 * the "Desktop app" client type, it cannot be kept confidential inside an
 * installed application, and Google's installed-app flow requires it on the
 * token exchange. A *web* client secret is a different thing: it stays on a
 * server and never belongs here.
 *
 * Filling this in changes what the user sees, so the project behind it is the
 * one that goes through Google's brand and restricted-scope verification: the
 * consent screen has to name Shun and carry the verified branding.
 */
export type OAuthClientRegistration = { clientId: string; clientSecret?: string }

/**
 * Registrations are read when a connector asks for one rather than at module
 * load, so a build that bakes the values in and a process that changes its
 * environment before connecting both behave the same way.
 */
const registrations: Record<string, () => OAuthClientRegistration> = {
  google: () => ({
    clientId: process.env.SHUN_GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.SHUN_GOOGLE_OAUTH_CLIENT_SECRET || '',
  }),
}

/**
 * The registration for a connector, or undefined when this build ships without
 * one. Callers treat undefined as "ask the user for their own credential", never
 * as a reason to fail on its own.
 */
export function oauthClientRegistration(id: string): OAuthClientRegistration | undefined {
  const registration = registrations[id]?.()
  const clientId = registration?.clientId.trim()
  if (!clientId) return undefined
  return { clientId, ...(registration?.clientSecret?.trim() ? { clientSecret: registration.clientSecret.trim() } : {}) }
}
