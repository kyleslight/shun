# Shun Browser Use Privacy Policy

Last updated: August 23, 2026

Shun Browser Use is a Chrome extension that lets the Shun desktop application inspect and control a Chrome tab during a user-requested Shun task. Its single purpose is to provide that browser-control connection.

## Data the extension can process

Only while a Shun task is using a claimed Chrome tab, Shun Browser Use can process:

- the tab URL and title;
- visible page text and accessibility information;
- screenshots requested by the task;
- page console messages and page errors;
- navigation, clicks, scrolling, and text entered through the Shun task.
- local files explicitly selected by a Shun task for upload, and the path and status of downloads started by the controlled tab.

The extension does not request access to Chrome's cookie store and does not read passwords from Chrome. Because it works with an existing Chrome tab, the page may already be signed in through Chrome's normal session.

## How data is used and transferred

The extension sends browser data only over a loopback connection on the same device to the locally running Shun desktop application. Shun uses that data to complete the browser task requested by the user. The extension has no advertising, analytics, or developer-operated remote service.

When a user chooses an AI model provider in Shun, browser tool results that are relevant to the task may be included in requests to that provider. That transfer is initiated by the Shun desktop application and is governed by the selected provider's terms and privacy policy. Users should not ask Shun to expose information they do not want sent to their configured provider.

Browser results may appear in the Shun task transcript and local browser snapshots. They remain on the device until the task or Shun application data is deleted. Shun does not sell this data, use it for advertising, use it to determine creditworthiness, or allow humans to read it except when the user deliberately shares it for support.

## Permissions

- `debugger` is required to obtain accessibility snapshots and screenshots and to perform user-requested navigation and input. Shun detaches the debugger automatically when the model run finishes, fails, or is cancelled.
- `tabs` is required to list, select, create, activate, and navigate the Chrome tabs explicitly used by a Shun task.
- `downloads` is required to start a user-requested download from a page link, wait for downloads initiated by the controlled tab, and return completion state and final local filename. It keeps Chrome's normal download directory, conflict handling, and safety checks.

The extension does not request broad website host permissions.

## Security and user control

The desktop bridge listens only on the local loopback interface and accepts the expected Shun extension origin. Browser access starts only during an explicit Shun task. A user can cancel Chrome debugging at any time, disable or remove the extension in Chrome, or quit Shun. Shun also releases attached tabs if the local bridge disconnects.

## Limited use

The use of information received from Google APIs complies with the Chrome Web Store User Data Policy, including its Limited Use requirements. Data is used only to provide the user-facing browser-control feature.

## Contact

Questions or privacy requests can be filed through the [Shun GitHub repository](https://github.com/kyleslight/shun/issues).
