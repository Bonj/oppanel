# oppanel

A web operator panel for FreePBX 17 / Asterisk 20+, built on the Asterisk Manager Interface (AMI). It shows extensions, queues, ring groups, IVRs, conferences and parking, and lets an operator originate, transfer and end calls.

A small Node.js bridge holds the AMI connection and serves a single HTML page over an authenticated WebSocket. AMI credentials never reach the browser.

## Features

- Live extension state, with the call each extension is on and its duration
- Queue and ring group tiles (members, callers waiting or ringing), IVR occupancy, conferences with members, parking lots
- Originate from any extension (the From phone rings first, then the target is dialled)
- Blind and attended transfer of bridged calls
- Send a ringing, queued, IVR, parked or conference caller to any destination
- Mute and remove conference members, end any call
- Shortcut buttons for common destinations
- Per-section contract button (show only items in use), light and dark theme
- Optional kiosk token sign-in for a wall display, and embedding in an iframe (e.g. Home Assistant)

## Requirements

- FreePBX 17 on Debian 12, Asterisk 20 or later, PJSIP endpoints, ConfBridge conferences
- Node.js 18 or later (the Debian 12 package is sufficient)
- Optional: a read-only MariaDB user for names and ring group membership

## Install

All steps run as root on the PBX.

1. **AMI user.** Append `deploy/manager_custom.conf.example` to `/etc/asterisk/manager_custom.conf`, set a long random secret, then `asterisk -rx "manager reload"` and check with `asterisk -rx "manager show user oppanel"`. Do not edit `manager.conf`; FreePBX regenerates it.
2. **Service account and files.**
   ```
   useradd -r -s /usr/sbin/nologin oppanel
   mkdir -p /opt/oppanel
   cp server.js index.html package.json /opt/oppanel/
   cd /opt/oppanel && npm install --omit=dev
   ```
   If `apt install nodejs` reports a held package, leave it alone; FreePBX pins its own Node.js, and any version 18 or later works.
3. **Database user (optional but recommended).** Edit the password in `deploy/db-grants.sql`, then `mysql < deploy/db-grants.sql`. It can read four tables and nothing else. Without it the panel still runs, and you name IVRs and list idle conferences with `IVR_NAMES` and `CONF_ROOMS`.
4. **Environment file.** Copy `deploy/oppanel.env.example` to `/etc/oppanel.env`, fill in the secrets, then `chown root:root /etc/oppanel.env && chmod 600 /etc/oppanel.env`.
5. **Service.**
   ```
   cp deploy/oppanel.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now oppanel
   journalctl -u oppanel -n 20 --no-pager
   ```
   The log should show `Panel on <address>:<port>` and `AMI connected`.
6. **Network.** The bridge listens on `127.0.0.1:8099` by default. To use it from other machines, set `LISTEN_HOST` to the PBX LAN address and open the port to your Local zone in the FreePBX firewall (Connectivity > Firewall > Custom Services). Do not use port 8088; Asterisk's HTTP server owns it.
7. **Sign in** at `http://<pbx>:8099/` with `PANEL_USER`, `PANEL_PASS` and the extension that acts as the operator.

To update, copy the changed files to `/opt/oppanel/` and `systemctl restart oppanel`. `index.html` is read once at start, so a restart is required for it too.

## Configuration

All settings are environment variables in `/etc/oppanel.env`. See `deploy/oppanel.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `AMI_USER`, `AMI_SECRET` | none, required | AMI credentials |
| `AMI_HOST`, `AMI_PORT` | `127.0.0.1`, `5038` | AMI address |
| `PANEL_USER`, `PANEL_PASS` | `operator`, required | Panel login |
| `LISTEN_HOST`, `LISTEN_PORT` | `127.0.0.1`, `8099` | Where the bridge listens |
| `DIAL_CONTEXT` | `from-internal` | Context used to dial originated and transferred calls |
| `ALLOW_IPS` | unset (allow all) | IPv4 addresses or CIDR ranges allowed to reach the panel |
| `DB_USER`, `DB_PASS`, `DB_SOCKET` | unset (database off) | Read-only database access. `DB_HOST` and `DB_NAME` (default `asterisk`) are also available |
| `CONF_ROOMS`, `IVR_NAMES` | unset | Manual lists, used without the database. `IVR_NAMES` overrides database names |
| `SHORTCUTS` | unset | `Label:code,Label:code` buttons that fill the Transfer to field |
| `KIOSK_TOKEN`, `KIOSK_IPS` | unset | Token sign-in for a display (at least 24 characters), optionally limited to client IPs |
| `FRAME_ANCESTORS` | unset (framing blocked) | Origins allowed to embed the panel in an iframe |
| `BACK_URL` | unset | Adds a "Back to dashboard" link (needs top navigation allowed by the embedding page) |

## How transfers work

- **Blind / Attended** appear on bridged two-party calls. Pressing one on a party sends that party to the Transfer to number. Attended makes the other party dial first, and it completes when that party hangs up. AMI cannot complete or cancel an attended transfer itself.
- **Send** appears on callers that are not bridged yet (ringing, queued, IVR, parked, conference members) and uses the `Redirect` action.
- Destinations accept digits, `*`, `#` and `+` only, and are dialled in `DIAL_CONTEXT`, so outbound routes and restrictions apply as they would from a handset.
- Clicking an extension, queue, ring group or conference fills the Transfer to and Call to fields.

## Embedding in Home Assistant

1. Set `FRAME_ANCESTORS` to the origin Home Assistant is served from (scheme, host and port, no path).
2. For keyboard-free sign-in, set `KIOSK_TOKEN` (and `KIOSK_IPS` to the display's address) and use `http://<panel>:8099/#t=<token>&e=<extension>` as the iframe URL. The page reads the token from the address, signs in, and removes it from the address. A fragment is never sent to the server.
3. For a way back to another dashboard view, put a native button above the iframe in a vertical stack:
   ```yaml
   type: vertical-stack
   cards:
     - type: button
       name: Back
       icon: mdi:arrow-left
       tap_action:
         action: navigate
         navigation_path: /<dashboard>/<view>
     - type: iframe
       url: http://<panel>:8099/#t=<token>&e=<extension>
       aspect_ratio: 50%
   ```
4. Both pages must use the same scheme. A browser blocks an HTTP page framed inside HTTPS.

## Security

- The panel gives full control of calls. The login password, and the kiosk token if used, are sent in a cleartext WebSocket message unless you put TLS in front.
- Run it on a trusted LAN, restrict it with `ALLOW_IPS` and the FreePBX firewall, and keep `/etc/oppanel.env` at mode 600.
- The kiosk token sits in the embedding page's configuration, so anyone who can read that page can read the token. Use `KIOSK_IPS` so it is useless from other devices, and change it to revoke it.
- The AMI user has no `command` class. Every argument from the browser is validated against live state before reaching AMI. There is no per-IP login rate limit.
- A reverse proxy for TLS needs `ProxyPreserveHost On`, because the WebSocket Origin must match the Host header. Behind a proxy, `ALLOW_IPS` and `KIOSK_IPS` see the proxy's address.

## Status

Developed against FreePBX 17, Asterisk 21.12.3, Debian 12, Node.js 18.

Confirmed working by the author: extension and call display, conference listing, blind transfer into a conference, `Redirect` of a conference member, IVR occupancy with database names, queue and ring group tiles, Send for unanswered incoming calls, section contract buttons, and kiosk token sign-in inside a Home Assistant iframe.

Not yet tested: completing and aborting attended transfers, parked-call display and Send after the `Parkinglot` field fix, ring group "ringing" detection for inbound-route calls, paused and ringing queue members, and the contracted view on a small screen.

Not supported: very old browsers. The page uses modern JavaScript and CSS, and an iPad on iOS 12 did not work.

## Troubleshooting

- **"Bridge cannot reach the PBX" at login:** the AMI login failed. Check `AMI_SECRET` against `manager_custom.conf` and run `asterisk -rx "manager show user oppanel"`.
- **`Cannot find module 'mysql2/promise'`:** run `npm install --omit=dev` in `/opt/oppanel`, then `systemctl reset-failed oppanel && systemctl restart oppanel`.
- **Queues or ring groups missing:** the database user is not configured, or `index.html` on the PBX is older than `server.js`.
- **Page blocked in an iframe:** `FRAME_ANCESTORS` is unset or wrong (origin only, no trailing slash).
- **Token link shows the login form:** open it in a new tab. Pasting a link that differs only after `#` into a tab that already has the panel open does not reload the page.

## Licence

None chosen yet. Add a `LICENSE` file before sharing the repository publicly.
