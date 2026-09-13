import { handleRegistryRequest, type RegistryEnv } from './registry.ts'

/**
 * Cloudflare Worker entry point for `api.shunagent.com`. Everything testable
 * lives in `registry.ts`; this file only wires the platform binding in.
 */
export default {
  fetch: (request: Request, env: RegistryEnv) => handleRegistryRequest(request, env),
}
