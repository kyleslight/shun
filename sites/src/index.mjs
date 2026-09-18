/**
 * Shun Sites service — the publishing backend Shun operates.
 *
 * Two hosts reach this Worker through one wildcard route:
 *
 *   sites-api.shunagent.site   the publishing API the desktop app calls
 *   <name>.shunagent.site      a published site, served read-only
 *
 * All Cloudflare knowledge lives here: the KV binding, the namespace, the
 * account. A client never holds a Cloudflare credential, never learns a zone or
 * an account, and never learns that any of this is Cloudflare. It sends a bundle
 * over HTTPS and receives a URL.
 *
 * Deployed once by the project, with `pnpm sites:deploy`. Users never run this,
 * and no part of the client depends on it existing locally.
 */
import gateway from '../../resources/plugins/sites/gateway/worker.mjs'
import { apiHost, handleApi } from './api.mjs'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname.toLowerCase() === apiHost) return handleApi(request, env)
    return gateway.fetch(request, env)
  },
}
