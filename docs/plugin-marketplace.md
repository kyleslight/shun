# Shun plugin marketplace

Plan of record for a plugin marketplace that mirrors the parts of VS Code's
extension model that matter, and drops the parts that do not fit Shun.

The publisher side already exists: `shun-plugin-development` plus the
`plugin_package` tool scaffold, validate, install, and test a package today.
What is missing is distribution, identity, and trust.

## Distribution tiers

Three tiers, distinguished by **where the code came from**, never by what a
manifest says about itself.

| | ① required | ② optional (bundled) | ③ marketplace |
| --- | --- | --- | --- |
| Source | `resources/plugins` | `resources/plugins` | registry download |
| Shipped state | installed, not removable | installable from the hub | installable from the store |
| Publisher identity | none (first-party) | none (first-party) | verified email + registry signature |
| Integrity | the signed `.app` bundle | the signed `.app` bundle | sha256 + registry signature |
| Updates | with the app, never networked | with the app, never networked | store update check |
| Permission consent | implicit | explicit | explicit |
| Namespace | `shun.*` reserved | `shun.*` reserved | publisher handle |

`distribution: "required" | "optional"` may be declared **only** in the bundled
root, defaults to `required` there, and is rejected outright on an installed
package. The tier is therefore a property of the application package and its
signature, not of a downloaded manifest.

### Iron rules

1. **The tier comes from the code location, never from a manifest.**
2. **Bundled ids are reserved forever, enforced on both sides** — the client
   already refuses to shadow a built-in package id; the registry holds the same
   list (exported from the repo at release time).
3. **A bundled package is never "updated" by the store.** One id belongs to one
   tier; `bundled 0.2.14` is not an older `0.9.0` from the store.
4. **Only tier ① grants permissions implicitly.** Tiers ② and ③ ask for consent,
   so an update can never widen access without the user seeing it.
5. **The client never asserts a publisher.** `publisher` on a marketplace
   package is written by the registry; display reads the registry, not the
   manifest.

## Publisher identity: verified email, no account

Shun stays usable without signing in. Only *publishing* needs an identity, and
that identity is a verified email plus a device key. The whole thing is one short
conversation, because the agent runs it:

1. The person says they want to publish. The agent calls
   `plugin_publish action=status`; if nothing is bound it asks for the email
   address that should own the plugin — never for a password, because there is no
   account.
2. `action=request_code` calls `POST /v1/publishers/challenge {email}` and the
   registry sends a six-digit code, valid ten minutes, single use.
3. The agent asks for the code and calls `action=verify_code`. The identity is
   remembered on that computer from then on.
4. `POST /v1/publishers/verify {challengeId, code, devicePublicKey}` creates the
   publisher and a device key; every later publish is signed by that key.

Settings → Publisher identity shows the verified address, the handle it publishes
under, and Unbind, for anyone who would rather see it than ask about it. (The
same sheet is reachable from the plugin hub.) The address is stored locally,
encrypted with platform secure storage; the registry keeps a peppered hash and
the domain.

Stored where: the refresh token is encrypted with Electron `safeStorage` in
`userData` (the same mechanism as `plugin-secrets.json` and mobile pairing); the
private key never leaves the device. Server-side the registry keeps the handle,
an **email hash and domain** (not the address), the device public key, and the
publish history. Without a device key a stolen token is useless, and without the
server-side binding the verification means nothing.

- **Unbind**: delete local credentials and revoke the device. Published versions
  stay (installs do not vanish); re-verifying the same email restores the
  publisher. The email *is* the recovery channel, so there is no password.
- **Namespace**: the handle is chosen at bind time, defaults to the email local
  part, is globally unique, and keeps a 90-day alias after a rename. One email
  means one publisher.
- **Display**: `handle · gmail.com`. The full address is never public.

### What this proves, and what it does not

Proves control of the mailbox — which for a company domain is control of that
domain. Does not prove a real-world identity, and says nothing about code
safety: that is what review, signatures, and revocation are for.

## Registry

Hosted on Cloudflare in the account that already serves `shunagent.com`.
Deployed as a **dedicated worker on `api.shunagent.com`**, so it never competes
with the static-assets worker that serves the marketing site.

- **D1** — `publishers`, `devices`, `plugin_versions`, `plugin_stats`,
  `reserved_ids`.
- **R2** — `shun-marketplace`: `plugins/<id>/<version>.shunplugin`, plus
  `.sha256` and `.sig`.
- **KV** — `CHALLENGES` (code hash, attempts, TTL), `BLOCKLIST` (signed kill
  list).
- **Email** — Resend over a plain HTTPS POST; no SDK needed on Workers.

Publishing is **curated**: a verified publisher's submission lands in the review
queue, and only an approval puts it in the catalog. The agent runs the whole
conversation — ask for an address, request a code, ask for the code, verify,
submit — and owns everything the store shows: description, icon, keywords,
license, engine floor, version bumps, and a changelog per version. Settings →
Publisher identity shows the verified address and offers Unbind. Versions are immutable, and
withdrawing a version records the fact rather than deleting the row an installed
copy resolves to.

### Publisher identity

One verified email, one device key, no account.

```
POST /v1/publishers/challenge   { email }                       -> 202 { challengeId, domain, handle }
POST /v1/publishers/verify      { challengeId, code, devicePublicKey } -> 201 { handle, domain, deviceId }
POST /v1/publishers/revoke-device                               (device-signed)
```

The code is stored as a hash of a pepper, the challenge id, and the code itself,
is single use, expires in ten minutes, and is rate limited per address. Verifying
creates an Ed25519 key pair on the publisher's machine; the private half is
encrypted with the platform's secure storage and never leaves it. Every later
request carries

```
Authorization: Shun-Publisher handle=…, device=…, timestamp=…, signature=…
```

over `<method>\n<path>\n<timestamp>\n<sha256 of the body>`, so a captured header
is useless for any other request, and a leaked database contains no credential.

The registry keeps a peppered hash of the address and its domain, never the
address itself.

### Withdrawing a version

Yanking stops new installs. **Blocking** also withdraws the version from copies
that are already on disk, which is the only way to react to a package that turned
out to be harmful:

```
POST /v1/plugins/:id/versions/:version/block   { reason }   (operator)
POST /v1/plugins/:id/block                     { reason }   (operator, every version)
GET  /v1/blocklist                                          (public, cached 5 minutes)
```

A reason is required, and it is served to the client: a withdrawn plugin is only
acceptable when the person running it is told why. The application reads the list
when the plugin hub opens, disables anything that matches, and shows the reason
with a one-click remove. An unreachable registry withdraws nothing — a client
never disables a plugin by accident.

### API v1

Read (public, unauthenticated, cached):

```
GET /v1/plugins?q=&cursor=&limit=
GET /v1/plugins/:id
GET /v1/plugins/:id/versions/:version
GET /v1/plugins/:id/versions/:version/download
GET /v1/blocklist
```

Write:

```
POST /v1/publish                                 multipart archive; operator or device-signed
POST /v1/submissions/:id/review { decision }     operator: publish, reject, or hide
POST /v1/plugins/:id/versions/:version/yank      operator: stop new installs, keep the record
```

Publishing re-validates the archive with **the same `validatePluginPackage` the
app ships**, so the store and the client can never disagree about what a valid
package is. Versions are immutable; republishing a version is rejected.

The installable package limit is **25 MB and 400 files**, enforced by the packer
at publish time and again on install. `pluginPackageDigest` keeps a much looser
safety valve (512 MB / 20,000 files) only so a development directory containing
`node_modules` cannot hang the installer.

## Application changes

- `plugin-engine` gate: `engines.shun` ranges decide compatibility
  (`src/main/plugin-engines.ts`).
- Package digest and provenance (`src/main/plugin-packages.ts`): every install
  records version, publisher, sha256, size, and origin next to the bytes, in
  `.installations.json`.
- Archive format `.shunplugin`: a deterministic zip (the existing `fflate`
  dependency) of the package directory. Entries are walked in a stable order and
  every entry carries one fixed timestamp, so packing the same directory twice
  produces the same bytes on the same machine. Two digests travel with it:
  `sha256` over the archive bytes (what a registry publishes and a client checks
  before extracting anything) and `contentSha256` over the package tree, which is
  identical for a directory, an archive, and the tree extracted from that
  archive. Symbolic links cannot be packed, hostile entry names are rejected
  before decompression, and the installable budget is 25 MB / 400 files.
- Installing an archive stages the verified extraction in a private temporary
directory, inspects it, obtains consent, then takes the same atomic swap a
  directory install takes — one install engine, two entrances. Every install
  records `sha256`, version, publisher, size, and origin beside the bytes.
- `plugin_package` gained `action=pack`, and `action=install`/`action=validate`
  accept an archive path, so the authoring loop closes: build, pack, install the
  artifact, test its views. The hub's "Install package" dialog accepts either a
  directory or a `.shunplugin` file.
- Registry client using `productFetch` (Chromium network stack — Node `fetch`
  does not work on the TUN-mode network this project is developed on).
- Store UI in the plugin hub: one searchable list covering all three tiers
  (built-in, bundled, marketplace), a tier label on each row, a community section
  fed by the registry, and an update row when the registry publishes a newer
  version than the installed provenance. An unreachable marketplace is a quiet,
  retryable note rather than an error state.
- **Explicit permission consent.** A plugin that declares permissions opens a
  sheet listing each permission with the author's own reason, and the grants
  written to settings are exactly what was approved. The required tier keeps its
  implicit grant because it ships inside the signed application; nothing else
  does. This is also the update path: a version that asks for something new can
  never inherit the earlier approval.
- Deep link `shun://plugin/<id>[?version=<version>]` from the website into the
  application. Shun registers the scheme itself and handles `open-url` (macOS),
  `second-instance` argv (Windows/Linux), and cold-start argv. A link **selects**
  a plugin and at most opens the consent sheet — it never installs.

## Website changes (`shun-site`)

The site is a static Next.js export served by a Cloudflare worker; a static
export cannot prerender plugin ids that do not exist at build time. So:

- `/plugins` — a browse page whose shell is static and whose catalog is fetched
  from `api.shunagent.com`.
- `/plugins/detail/?id=<id>` — a single static route that renders the detail
  page on the client.
- "Install in Shun" → `shun://plugin/<id>`, with a download/CLI fallback for
  browsers that cannot open the protocol.
- `/publish` — the short version of the publisher flow, linking into the app.

Per-plugin SEO (titles, OG images) needs runtime HTML, which means giving the
site worker a script or templating `/plugins/*` separately. Deferred until the
catalog is large enough to matter.

## Phases

| Phase | Scope | State |
| --- | --- | --- |
| M0 | Manifest contract: `distribution`, `engines.shun`, store metadata, digest + provenance, tier enforcement | **done** |
| M1 | `.shunplugin` archive, pack/unpack, install from file, integrity check, provenance display | **done** |
| M2 | Registry MVP (read API + seed catalog) + in-app store + update check + `shun://` deep link | next |
| M2 | Registry MVP (read API + seed catalog) + in-app store + update check + `shun://` deep link | planned |
| M3 | Publisher accounts, publish flow, review queue, signing, revocation | planned |
| M4 | Verified-publisher badges, abuse reports, malware scanning, metrics | planned |
| M5 | Plugins that ship executables (`runtime.executables`), macOS notarization | later |

## Email verification codes

Resend sends the code. Three steps need a human; the DNS records do not.

1. **Create a Resend account** (free tier: 3,000/month, 100/day).
2. **Verify a sending subdomain**, for example `mail.shunagent.com`. Resend shows
   the SPF, DKIM, and DMARC records; the zone is on the same Cloudflare account,
   so the API can add them — only the values have to be handed over.
3. **Create an API key** and set it as the worker secret:

   ```
   wrangler secret put RESEND_API_KEY --config registry/wrangler.toml
   wrangler secret put MAIL_FROM        --config registry/wrangler.toml   # "Shun Marketplace <publish@mail.shunagent.com>"
   ```

Cloudflare Email Routing cannot send this mail (`send_email` only reaches
verified addresses), so a transactional provider is the right call.

Until the key exists the registry refuses the request with a sentence that says
exactly that, and locally (`pnpm registry:serve`, `MAIL_TRANSPORT=console`) the
code comes back in the response so the whole flow can be exercised offline.

## Privacy note

The README and `PRIVACY.md` currently say Shun has no telemetry, no account, and
no cloud tier. Publishing is the first feature that stores anything server-side:
a handle, an email hash and domain, a device public key, and publish history,
only for people who choose to publish. The privacy policy must say exactly that
before the marketplace is public, and the statement must be added while the
Google OAuth verification submission is not being edited, so the two do not
change under the same review window.
