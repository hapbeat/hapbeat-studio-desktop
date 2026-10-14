# Hapbeat Studio for Windows

Hapbeat Studio as a Windows app. Install it and double-click: no Python, no command line.

- The screens are the online Hapbeat Studio (<https://studio.hapbeat.com>), loaded at every launch. New Studio features, templates and firmware appear in the app as soon as they are on the web.
- The Hapbeat Helper (the part that talks to the devices on your network) is built in and starts and stops with the app.
- The app opens with Kit, UI and Manage. "Show all features" in the Helper panel (top right) adds the editor and the other tabs.
- The app updates itself when a new version is released.

An internet connection is needed to open the app.

## First launch

1. Run `HapbeatStudio-Setup-<version>.exe`. It installs for the current user (no administrator rights) and starts the app.
2. If Windows SmartScreen says the app is unrecognised, choose **More info → Run anyway**.
3. If Windows Firewall asks about `hapbeat-helper`, choose **Allow access**. Without it the app cannot find devices on the network.

If a Helper installed with pipx is already running, the app uses it and does not start its own.

## Development

Requires Node.js 22 and Python 3.12 (Windows).

```powershell
npm ci
npm run build:helper          # bundled helper from PyPI (helper/helper-version.txt) → helper/dist/
npm start                     # the app against studio.hapbeat.com
$env:HAPBEAT_STUDIO_URL = "http://localhost:5173/"; npm start   # against a local Studio dev server
npm test
npm run dist                  # installer → release/
```

- `npm run build:helper -- -Source ..\hapbeat-helper` bundles a local helper checkout instead of the PyPI release.
- `HAPBEAT_HELPER_PORT` starts the bundled helper on another port (checks only; Studio connects to 7703).
- Studio shows its desktop layout when the page is opened with `?shell=desktop` (the app does this) or when `window.hapbeatDesktop` exists (the app's preload).

## Releasing

1. Set `version` in `package.json` (and `helper/helper-version.txt` when the bundled helper changes).
2. Push the tag `v<version>`. CI builds the installer into a draft GitHub Release.
3. Check the installer on a PC with a Hapbeat, then publish the draft. Installed apps update from published releases only.

A Studio change needs no release of this app, with one exception: when Studio starts to need a newer helper (`MIN_HELPER_VERSION` in hapbeat-studio `src/config/helperCompat.ts`) than the app bundles, release the app with that helper and publish it **before** deploying Studio. Otherwise release only when the bundled helper or the app itself changes.

Only `vX.Y.Z` tags are built. Development versions (`0.1.1-d1`) stay local.

## License

MIT
