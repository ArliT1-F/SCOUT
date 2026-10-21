# Desktop host and public website

## Windows application

The normal **SCOUT** shortcut and **Start SCOUT now** action must run `host/scout-shell.exe`,
not `scout-host.cmd` or a browser. The native application:

1. Shows the launcher GUI immediately.
2. Starts the bundled Node host with `CREATE_NO_WINDOW`, in host mode, logging to
   `%APPDATA%\SCOUT\scout-host.log`.
3. Waits for the local `/healthz` response, then navigates the launcher window to `/app` natively.
   This does not rely on cross-origin fetch from the bundled splash page.
4. Hosts the full broadcast dashboard locally. F9 toggles the operator panel; F8 toggles the overlay;
   Ctrl+Shift+F8 quits. The launcher stops the Node process it started when the application exits.

Launching the executable directly also reads the installed port; explicit `--url` takes precedence.
The console shortcuts remain labelled **advanced** for diagnostics only. The browser-panel shortcut
points to `/panel`, not the public owner's `/admin`.

`npm run package:windows` requires a successful GUI build. A compiler failure is printed and stops
packaging. Inno Setup independently rejects a staged tree without `scout-shell.exe`. `--no-shell`
is allowed only alongside `--no-installer` for staging tests. Previously a failed GUI build could
silently produce a console-only installer; **existing downloaded installers are not changed by this
source fix**. Build and publish a new Windows installer, then reinstall/update it.

## Public deployment

```sh
npm ci
npm run build
npm start                  # production website, binds 0.0.0.0:8080 (or PORT)
# npm run website          # website with development assets
```

The website entrypoint forces `SCOUT_SURFACE=site`. If a deployment directly starts
`server/index.ts` instead, set `SCOUT_SURFACE=site` explicitly. An invalid surface value is an error.

Website responsibilities:

- `/` redirects to `/welcome`: product landing page and beta application at `/apply`.
- `/login`: account sign-in, invite activation, and approval of a launcher's device code.
- `/profile`: account/beta status, linked installations, unlinking and sign-out.
- `/privacy`: what the website and account service collect, retention, deletion, and the
  first-party analytics allowlist (no third-party trackers).
- `/download`: installer access for approved users.
- `/admin`: owner-only application decisions (including a copyable one-time invite link),
  available map rotation, application availability, account limits and public-stat settings.

The website refuses `/app`, `/panel`, `/game`, `/obs`, `/gsi`, `/ws` and broadcast APIs such as
`/api/config`, `/api/status`, uploads and operator sessions. Authenticated machine-to-machine
`/api/platform/device/sync` and `/metrics` remain available for host synchronization. These do not
make the website a live broadcast host. Existing account and owner authorization still apply;
local machine trust is not sufficient to approve an application or edit owner settings.

For a local host use `npm run host` (or `npm run dev`); production installs run the compiled
`host/server/index.js` directly. Never expose that local host as the public website.

## Owner settings and offline hosts

Configure `SCOUT_OWNER_EMAIL` on the website and, if used, the hosted account service. The owner
must have an approved account and sign in with it. Keep `SCOUT_BETA_API_KEY` on central services,
not on venue machines. See `.env.example`, `docs/BETA.md`, and `docs/ACCOUNT-SERVICE.md` for
account bootstrap and hosted-service setup.

Set `SCOUT_PLATFORM_URL` on each venue host to the **website's public base URL**, not the SQLite
account-service URL. It can be baked into an installer at build time. Link each host using a device
code and an approved account. Linked hosts poll the central website every 15 seconds; no open
browser is required. A host configured with a hosted account service also refreshes settings from
that service when permitted; an unavailable/unauthorized service leaves the cache untouched.

The owner's map rotation is versioned with the other settings. New map selections and the default
for an added series map follow that rotation. An existing match keeps its current maps, including
maps removed from the new rotation, so settings updates never interrupt a running broadcast.
Invalid or empty rotations are ignored rather than emptying host pickers. The last downloaded
settings persist in `config/platform/store.json` and remain usable offline. Reconnection downloads
the latest settings automatically. Settings-only sync does not overwrite local teams, match series,
radar calibration, layout or overlay design. Hosts without a configured platform retain local defaults.

## Verification

Automated tests cover the HTTP site/host boundary, owner-to-linked-host rotation synchronization,
offline retention/reconnection, safe map pickers, and installer packaging guards. Linux staging tests
verify the compiled host with panel, app, OBS and GSI routes. They do **not** validate WebView2 or
execute a Windows `.exe`.

Before publishing a new installer, test on Windows 10/11:

- Build with Rust, Tauri CLI, WebView2 and Inno Setup. A GUI compilation failure must stop packaging.
- Install into a path containing spaces, select a non-default port, leave **Start SCOUT now** checked.
- Confirm a SCOUT GUI opens without a CMD window; dashboard and panel load without opening a browser.
- Launch again from both shortcuts and directly from `scout-shell.exe`; confirm the selected port.
- Open `/admin` on the website, approve an applicant, copy the invite, activate it and link a host.
- Change the map rotation; confirm its host picker updates within the polling interval.
- Disconnect host internet, restart it and verify the cached rotation and local broadcast still work;
  reconnect and verify the newest rotation arrives without altering the current series.
