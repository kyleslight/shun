---
name: sites-publishing
description: Publish a local web project to a live URL in the conversation, and manage what is already online — protection, pausing, taking it down.
---

# Sites publishing

Publishing happens **in the conversation**. The Sites panel exists as a second
entrance for whoever wants to see or manage the list, and no step of this
workflow requires opening it.

## When to act

"发布" / "publish" / "deploy" is not a Sites request by itself. It may mean
releasing the desktop client, deploying a service to another host, pushing to the
user's own infrastructure, or shipping a build to a teammate. Act only when the
user asks to publish **with Sites** — by naming it, naming this plugin, or naming
the publishing domain — or when they accept an offer you made.

The moment to offer is a finished preview. When you have previewed the page and
the user is satisfied with it, you may offer once, in one sentence, and present
the Sites panel with `plugin_view_present` so the offer is a card they can act on
rather than prose they have to interpret. Offer once; if they decline or ignore
it, drop it and do not raise it again for that project.

Never publish because a build finished, because a preview exists, or because a
sentence contains a word that could mean publishing. When the intent is genuinely
unclear, ask which one they mean — one short question, then do exactly that.

## Who may publish

Publishing is tied to a verified email address: the same identity the marketplace
already uses for plugins. If `plugin_publish` reports no bound identity, run that
short flow first — ask for the address, request the code, ask for the six digits,
verify — and then publish. Never invent an alternative, and never claim a site can
be published without it. The verified address is what makes an address yours and
lets you take it down again.

## The boundary that matters

Publishing is an external mutation: it puts files on the public internet at a
guessable address. Publish, protect, pause, and take down only when the user
explicitly asked for that exact action, and say what will become public before
you do it. Never publish as a way to check a build, and never republish a site
the user has not asked about. A published URL is public the moment it answers.

## Publish

1. Build first, with the project's own command through the normal workspace
   tools. Sites publishes static files; it does not build and does not guess a
   framework.
2. `sites_publish` without `path` returns the folders that look like build output
   plus the project's build script. Pick one from that list.
3. `sites_publish` with `path` uploads only the files that changed, returns the
   live URL, and verifies that address answers. Report the URL.
4. Nothing has to be configured first: publishing talks to Shun's own service,
   which the project operates. The user never sets anything up, never sees an
   account, a token, or where any of it runs.
5. **Never ask the user for a domain or a subdomain.** Every site lives under the
   one publishing domain, and its address is assigned automatically: the project's
   own name when it is free, the address it already has when it is republished,
   and the next free variant otherwise. A clash is not a question — the result
   says which name was taken and which address was used instead, so report the
   URL that actually answers.

## Protect, pause, bring back

The user asks in a sentence and the tool does the rest:

- `sites_access` with `visibility: password` protects a site. **Leave `password`
  out unless the user named one** — a generated password is returned once, in the
  tool result. Put it in your reply, say it is shown once, and never repeat it
  later in the conversation or write it to a file.
- `visibility: public` makes it public again; `visibility: off` pauses it so the
  address stops serving while the files stay.
- Re-selecting `password` without a password keeps the one that already works;
  pass a new one only when the user asks to change it.
- `sites_delete` removes the site and its files. Never delete a site to make
  room; ask.

## Managing without a conversation

`sites_list` reads what is published — use it before answering any question about
a site instead of recalling an earlier publish. The panel is useful for looking
at several sites at once, and the host offers it after a publish; never open it
as a required step, and never reopen one the user has closed.

## Environment facts worth knowing

- Every site answers at `<name>.<publishing-domain>`, one wildcard address serves
  all of them, and the free Universal SSL certificate covers exactly one level
  below the zone. Do not propose a deeper subdomain: it needs a paid certificate.
- One address belongs to one project. Replacing an address another project
  published is only ever done when the user asks for it, through `take_over`.
- One file is limited to 25 MiB, one publish to 5,000 files and 200 MB, and a KV
  account to 1,000 writes per day. A large first publish of a media-heavy site
  can hit that; say so plainly instead of retrying.
- The service is read-only towards browsers. Nothing about a published site can
  be changed from the network side, and a site password protects casual access
  only — it is not encryption and not access control for sensitive content.
