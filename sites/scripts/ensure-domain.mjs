#!/usr/bin/env node
/**
 * Deployment plumbing for the publishing domain.
 *
 * The product serves sites from one wildcard hostname, and the zone needs that
 * one record to exist before the service can answer. Doing it here keeps it where
 * it belongs: on a machine that already holds a deployment credential, run by
 * whoever deploys the service. It is never part of the application, never runs on
 * a user's machine, and nothing about it is ever shown to a person using Shun.
 */
const domain = (process.env.SHUN_SITES_DOMAIN || 'shunagent.site').toLowerCase()

/** Which record, if any, the deployment needs. Pure so it can be tested. */
export function recordPlan(existing) {
  const wildcard = `*.${domain}`
  const found = (existing || []).find(record => record.name === wildcard)
  if (found) return { create: false, record: { type: 'AAAA', name: wildcard, content: '100::', proxied: true } }
  return { create: true, record: { type: 'AAAA', name: wildcard, content: '100::', proxied: true } }
}

async function main() {
  const token = String(process.env.CLOUDFLARE_API_TOKEN || '').trim()
  if (!token) throw Error('Set CLOUDFLARE_API_TOKEN (a deployment credential) to provision the publishing domain.')
  const request = async (path, init = {}) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
    })
    const value = await response.json()
    if (!response.ok || value.success === false) {
      throw Error(`Cloudflare API ${response.status}: ${(value.errors || []).map(error => error.message).join('; ') || response.statusText}`)
    }
    return value.result
  }

  const zoneId = String(process.env.SHUN_SITES_ZONE_ID || '').trim() || (await request(`/zones?name=${encodeURIComponent(domain)}`))?.[0]?.id
  if (!zoneId) throw Error(`${domain} is not in this account.`)
  const plan = recordPlan(await request(`/zones/${zoneId}/dns_records?per_page=100&name=${encodeURIComponent(`*.${domain}`)}`))
  if (!plan.create) return console.log(`[sites] ${plan.record.name} is already in place`)
  await request(`/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(plan.record) })
  console.log(`[sites] created ${plan.record.name}`)
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) await main()
