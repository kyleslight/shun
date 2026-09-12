# Install Shun Browser Use

Shun Browser Use is the Chrome extension that lets a Shun task inspect and control one
Chrome tab you hand to it. There are two ways to install it.

## Chrome Web Store (preferred)

```
https://chromewebstore.google.com/detail/nlgfkakiggbllngkkfbjicnelmmnacbnb
```

Status: submitted for review on 2026-09-13 and pending. Until it is published, use the
unpacked install below.

Switching over is one flag: `SHUN_CHROME_EXTENSION_STORE_LIVE` in
`src/main/chrome-browser.ts`, which is `false` while the listing is pending. Setting it to
`true` makes **Plugins → Browser Use** open the listing instead of the developer-mode
walkthrough, and changes the plugin's setup label to "Add Shun Browser Use from the Chrome
Web Store". Nothing else changes — the bridge already accepts both extension origins.

The store build has its own extension ID (`nlgfkakiggbllngkkfbjicnelmmnacbnb`). The local
bridge in Shun accepts both that ID and the unpacked one below, so either install
connects — but install one copy, not both, so you are not looking at two toolbar icons.

## Unpacked install (works today)

1. Install and open Shun.
2. Open **Plugins**, install **Browser Use**, and choose **Set up Chrome**.
3. Shun opens `chrome://extensions` and a stable local extension folder.
4. Turn on **Developer mode**, choose **Load unpacked**, and select that folder.

This is a one-time setup. Shun copies the bundled extension into its per-user application
data directory, so the Chrome path stays stable across Shun upgrades. A later Shun release
can refresh the files in that same directory. Chrome will show that a developer-mode
extension is installed while this distribution method is in use.

When a Shun update includes a newer extension, open **Plugins → Browser Use** and choose
**Update extension**. Shun replaces the files in the same stable directory and opens
`chrome://extensions`; click **Reload** on the Shun Browser Use card. Chrome does not
provide a reliable, supported way for a normal desktop app to reload a developer-mode
extension silently.

Do not load the extension directly from a downloaded DMG, ZIP, temporary folder, or Shun's
installation resources.

## Why the unpacked copy has a fixed ID

The bundled manifest carries a `key` field, which is what pins the unpacked extension's ID
to the value the desktop bridge expects. Chrome computes a path-based ID for unpacked
extensions otherwise, and the bridge would then refuse the connection.

The store package cannot carry that field: the Chrome Web Store rejects an upload whose
manifest contains `key`. That is why the published build has a different ID, and why the
bridge allowlists both.

## Runtime behavior

Browser Use reuses the user's existing Chrome tabs, login state, cookies, and extensions.
Chrome shows its standard debugging notice only while a Shun model run is actively
controlling a tab. Shun detaches automatically when that run succeeds, fails, is cancelled,
or loses the local bridge. It leaves the user's tab open.
