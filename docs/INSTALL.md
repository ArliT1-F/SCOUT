# Getting SCOUT running

This page is for the person sitting at the observer machine, not for a programmer. It assumes you
have Windows and the file your SCOUT dashboard gave you: **`SCOUT-Setup-0.1.0.exe`** (the version in
the name is whatever was released last). Nothing here needs a command prompt, Node.js, or any
programming tool.

If you are the one *building* that installer, you want [RELEASE.md](RELEASE.md) instead.

## 1. Install it

1. Open your SCOUT dashboard in a browser, sign in, and press **Download the launcher**.
2. Double-click the downloaded file.
3. Windows will show a blue box saying **"Windows protected your PC"**, because SCOUT's installer is
   not signed with a paid certificate yet. Press **More info → Run anyway**. This is expected, and
   it is the same box every small-project installer shows.
4. Click **Next** through the wizard. You will be asked for:

   | | |
   | --- | --- |
   | **Where to put the program files** | The default is fine. |
   | **The port SCOUT listens on** | 8080 unless something else already uses it. Leave the default unless you have a reason. |
   | **Whether other machines may control SCOUT** | Off means: this computer only. Turn it on if a second person should be able to open the panel from a laptop or phone on the same network — the installer then shows you a link with a token once, and you can hand that to them. |
   | **WebView2** (Windows 10 only) | Tick it if offered: the overlay window needs it. Windows 11 has it built in. |
   | **Firewall** | Allow it, otherwise OBS and CS2 cannot talk to SCOUT on the same machine. |

5. Leave **"Start SCOUT now"** ticked. When the wizard finishes, SCOUT starts by itself.

## 2. Start it (after that)

There is one icon in the Start menu and, if you asked for it, on the desktop:

> **SCOUT** — press it. It starts everything: the CS2 feed, the control panel window, and the overlay
> that sits on top of CS2. The first start takes a few seconds. Nothing else needs starting.

| Key | What it does |
| --- | --- |
| **F9** | Shows and hides the control panel window. |
| **F8** | Turns the overlay over CS2 on and off (when CS2 is in front). |
| **Ctrl+Shift+F8** | Quits SCOUT — the overlay, the panel and the CS2 feed all stop. |

The **SCOUT control panel (in your browser)** entry opens the same panel as a normal browser tab,
which is handy for a second screen or a phone on the same network. The other two entries
(**SCOUT host (advanced…)** and **Stop SCOUT**) exist for people who want to watch the log in a
console or leave the host running as a background service; you never need them for a normal event.

## 3. The first five minutes in the panel

The panel is where matches are set up. The tabs you will touch first:

- **Overview** — the state of everything: the CS2 feed, what is on air, the OBS connection.
- **Teams, players, maps** — your teams, rosters and the map pictures. Nine maps are already there.
- **Broadcast scenes** — what the overlay shows and when.
- **OBS** — shows the address to paste into OBS. In OBS: **Sources → + → Browser**, size
  **1920×1080**, paste the address, and switch *Shutdown source when not visible* **off**. Do not add
  a chroma key and do not add Custom CSS: SCOUT's overlay is transparent by itself.
- **Launcher link** (in the sidebar) — links *this installation* to your SCOUT account, so the panel
  can tell you whether the launcher is still allowed to run. Press **Link this installation**, then
  open your dashboard in a browser and approve the code shown.

Nothing about a match leaves your computer: SCOUT reads the game's own Game State Integration feed
(which CS2 sends to `127.0.0.1`), and the only thing it ever asks the internet is the account service.

## 4. Where your things live, updating and uninstalling

| | |
| --- | --- |
| **Your data** | `%APPDATA%\SCOUT` — teams, logos, radar calibration, recordings, and the notes file that came with the install. Paste that path into the address bar of any Explorer window to open it. |
| **Updating** | Run the newer `SCOUT-Setup-x.y.z.exe` over the old one. Your data stays where it is; the installer only replaces the program files. Keep the same port if you changed it. |
| **Uninstalling** | *Settings → Apps → SCOUT → Uninstall*, or the **Uninstall SCOUT** entry in the Start menu. Your data directory is left alone, so an uninstall does not throw away a season of recordings. Delete it by hand if you really want it gone. |
| **A log to send** | `%APPDATA%\SCOUT\scout-host.log` — the last 1 MB of what SCOUT's host did. If something goes wrong, that file plus a sentence about what you did is the most useful thing you can send. |

## 5. If something is not right

| What you see | What to try |
| --- | --- |
| Nothing happens when you press **SCOUT** | Wait ten seconds — the first start is slower than the rest. If still nothing: is there a window called "SCOUT" in the taskbar? Try the **SCOUT host (advanced…)** entry once; its console window says what is wrong, and it is also the fastest way to get a message worth sending. |
| Windows blocked the installer | *More info → Run anyway*. This is the missing code-signing certificate, not a virus warning. |
| The panel window is empty, or says the host is not reachable | The host has not finished starting, or it stopped. Close SCOUT (Ctrl+Shift+F8), press the **SCOUT** icon again, and look at `scout-host.log` if it stays empty. |
| The overlay does not appear over CS2 | CS2 must run in **Fullscreen Windowed** (borderless) — a window cannot be drawn over exclusive fullscreen. Then press **F8**. |
| The overlay is over CS2 but nothing is on OBS | Check the Browser source address and size in the OBS tab of the panel; *Shutdown source when not visible* must be off. |
| The panel says the CS2 feed is stale | CS2 is not sending data. Check that SCOUT's Game State Integration config is in CS2's `game\csgo\cfg` folder (the installer puts it there) and that CS2 was restarted after the install. |
| You are on a second computer and the panel wants a token | Remote control was either left off at install time, or the token changed. On the observer machine, run the installer again and turn remote access on; it prints a fresh link. |

## 6. What SCOUT does not do

SCOUT never reads CS2's memory, never injects anything into the game, and never joins a match as a
player. It shows a window over the game and translates the scores CS2 broadcasts to your own machine.
As with any third-party software near a game, follow your event's rules.
