# artifact-stage

A Hermes plugin pair: a **session-driven shared artifact pane** for the desktop app,
with the session side driving it through a plain CLI.

- **Desktop pane** (`desktop/plugin.js`) — standalone desktop plugin; polls the Python
  backend and renders PDF / image / HTML / markdown / text with zoom + scroll.
- **Backend** (`dashboard/plugin_api.py`) — dashboard plugin API mounted at
  `/api/plugins/artifact-stage/`; serves control state, staged artifact bytes, and
  stores pane display receipts (acks).
- **Session driver** (`bin/artifact-stage`) — any session puts the artifact on the
  stage by writing the control file; no API credentials involved.

## Install

```bash
hermes plugins install pappdavid/hermes-plugin-artifact-stage
```

The installer copies the plugin into `~/.hermes/plugins/artifact-stage/` and offers to
enable it. The desktop pane is a separate load path — copy it once:

```bash
mkdir -p ~/.hermes/desktop-plugins/artifact-stage
cp ~/.hermes/plugins/artifact-stage/desktop/plugin.js \
   ~/.hermes/desktop-plugins/artifact-stage/plugin.js
```

Install the session driver:

```bash
mkdir -p ~/.hermes/bin
cp ~/.hermes/plugins/artifact-stage/bin/artifact-stage ~/.hermes/bin/
chmod +x ~/.hermes/bin/artifact-stage
```

Then reload desktop plugins in the app (command palette → "Reload desktop plugins")
and restart the app once so its backend mounts the API.

## Usage

From any session (CLI, desktop chat, cron worker):

```bash
~/.hermes/bin/artifact-stage open /path/to/report.pdf --title "Q3 report"
~/.hermes/bin/artifact-stage open /path/to/notes.md   # markdown/text render inline
~/.hermes/bin/artifact-stage scroll 50                # scroll the pane to 50%
~/.hermes/bin/artifact-stage zoom 1.5
~/.hermes/bin/artifact-stage clear
~/.hermes/bin/artifact-stage status                   # state + pane ack receipt
```

The pane reports display receipts to `~/.hermes/runtime/artifact-stage/ack.json` —
the session-side proof that the artifact actually rendered on the user's screen.

## Tests

```bash
python -m pytest test_plugin_api.py
```

Six in-process tests cover the API contract: state read, ack round-trip, artifact
byte serving, path-traversal rejection, and the session CLI round-trip.

## Notes

- Control plane is file-based on purpose: `~/.hermes/runtime/artifact-stage/state.json`
  is the single control file, written atomically. Sessions never call the dashboard API.
- Artifact ids are content hashes; only `[A-Za-z0-9._-]` names are served, and the
  served path is constrained to the artifacts directory.
- The pane is a plain-ESM single file loaded uncompiled by the desktop plugin loader —
  no build step, hot-reloads on save.
- v1 limitation: the embedded PDF viewer scrolls internally, so `scroll` applies to
  text/image/HTML content; PDF gets page-fit zoom.
