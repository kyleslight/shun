---
name: sites-publishing
description: Publish a local web project to a live URL in the conversation, and manage what is already online — protection, pausing, taking it down.
---

# Sites publishing

Publishing happens **in the conversation**. The Sites panel exists as a second
entrance for whoever wants to see or manage the list, and no step of this
workflow requires opening it.

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
4. Publishing **sets publishing up on first use**: it resolves the Cloudflare
   zone, creates the KV namespace and the read-only gateway, binds one wildcard
   host, and reports both in the result. Do not ask the user to configure
   anything first, and do not open a panel to do it.
5. Pass `base_domain` only to choose the domain when the token can see more than
   one zone. When the choice is ambiguous the tool answers with the list of
   zones — ask the user which one, in one question.

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

- Every site answers at `<slug>.<base-domain>`, one wildcard address serves all
  of them, and the free Universal SSL certificate covers exactly one level below
  the zone. Do not propose a deeper subdomain: it needs a paid certificate.
- One file is limited to 25 MiB, one publish to 5,000 files and 200 MB, and a KV
  account to 1,000 writes per day. A large first publish of a media-heavy site
  can hit that; say so plainly instead of retrying.
- The gateway is read-only. Nothing about a published site can be changed from
  the network side, and a site password protects casual access only — it is not
  encryption and not access control for sensitive content.
