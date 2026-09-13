# Gmail OAuth: credentials, Google verification, and what still blocks one-click

Shun's Gmail plugin authorizes through a host-owned OAuth client. Whether that
client ships inside the app decides whether connecting Gmail is one click or a
few minutes of setup, and Google decides whether a client may ship at all.

## How a registration reaches a build

Nothing is committed. The main build bakes two environment variables into the
bundle (`electron.vite.config.ts` → `src/main/oauth-clients.ts`):

```dotenv
SHUN_GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com
SHUN_GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-…
```

`.env.release` (ignored) supplies them for `pnpm release:publish`; a development
build reads the same variables from the shell. Without them the build ships no
client, and the plugin asks the user for their own — the documented fallback,
not a failure.

## Current state of the Google project (Cloud Console, 2026-09-13)

- Project `electric-charge-508418-s5` (Shun), OAuth client "Shun desktop"
  (Desktop app), Gmail API **enabled**, publishing status "In production".
- **Branding**: "Your branding is currently under review."
- **Data access**: no scopes are declared. `gmail.modify` is a *restricted*
  scope, and the restricted-scope form requires a usage ("Email productivity"),
  a justification, **and a demo-video link** before the page lets it be saved.
  Saving is what submits it for Google's restricted-scope review.
- Consequence today: a bundled client cannot finish Gmail authorization, because
  the scope it asks for is not declared on the consent screen.

## Path A — ship a bundled client (needs the demo video)

1. Google Auth Platform → Data access → **Add or remove scopes** → paste
   `https://www.googleapis.com/auth/gmail.modify` → **Add to table** → **Update**.
2. Usage: **Email productivity**. Justification: why `gmail.modify` and not a
   narrower scope (the plugin reads *and* acts in one task).
3. Demo video. Google's own requirements, from the same page: the video must
   demonstrate how the app uses the data; it must include every OAuth client
   assigned to the project; and because the app is already public, record it in a
   staging environment, a hidden test route, or a separate test project. Google
   shows the unverified-app screen for the recording account on purpose — that
   screen is expected and must appear in the video.
4. Upload it to YouTube (unlisted is fine), paste the link, **Save**. That starts
   Google's restricted-scope review; the Verification Center then tracks it.

Only the project owner can record and upload that video: it has to show their
app, their account, and the consent screen they approve. Everything else in this
document — the scope, the usage, the justification, the release configuration —
is prepared and can be completed in one sitting.

## Path B — no bundled client (works today)

Nothing to review, nothing to record. Users create their own OAuth client
(Google Cloud → Credentials → Create credentials → OAuth client ID → Desktop
app), paste the downloaded JSON into the Gmail plugin, and connect. The plugin
already accepts that path and says so when a build ships no registration
(`src/main/gmail-rest.ts`).
