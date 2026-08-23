# Install Shun Browser Use

## Installation while the Chrome Web Store release is paused

1. Install and open Shun.
2. Open **Plugins**, install **Browser Use**, and choose **Set up Chrome**.
3. Shun opens `chrome://extensions` and a stable local extension folder.
4. Turn on **Developer mode**, choose **Load unpacked**, and select that folder.

This is a one-time setup. Shun copies the bundled extension into its per-user application data directory, so the Chrome path remains stable across Shun upgrades. A later Shun release can refresh the files in that same directory. Chrome will show that a developer-mode extension is installed while this distribution method is in use.

When a Shun update includes a newer extension, open **Plugins → Browser Use** and choose **Update extension**. Shun replaces the files in the same stable directory and opens `chrome://extensions`; click **Reload** on the Shun Browser Use card. Chrome does not provide a reliable, supported way for a normal desktop app to reload a developer-mode extension silently.

Do not load the extension directly from a downloaded DMG, ZIP, temporary folder, or Shun's installation resources.

## Future Chrome Web Store release

The store release is intentionally paused until Browser Use has been proven stable in normal use. When it is published later, Shun can link directly to the listing. Remove the unpacked copy first if both copies appear in Chrome.

## Runtime behavior

Browser Use reuses the user's existing Chrome tabs, login state, cookies, and extensions. Chrome shows its standard debugging notice only while a Shun model run is actively controlling a tab. Shun detaches automatically when that run succeeds, fails, is cancelled, or loses the local bridge. It leaves the user's tab open.
