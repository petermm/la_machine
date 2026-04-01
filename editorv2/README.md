# Editor V2

`editorv2` is a small static Blockly prototype for editing one choreography line
at a time.

Why it is shaped this way:

- no build step in this repo right now
- logic is split into tiny browser modules so it can later move into a
  LiveView hook without rewriting the parser or the visualization
- it edits a single choreography line instead of taking over the full
  `choreographies.json` workflow

Files:

- `index.html`: standalone shell
- `app.mjs`: mount and glue code
- `blockly_editor.mjs`: custom blocks and workspace helpers
- `parser.mjs`: parse and serialize choreography strings
- `visualizer.mjs`: timeline and servo preview

Current behavior:

- imports a choreography value or a full JSON line
- edits it in Blockly
- exports a JSON-ready choreography value plus a full JSON line
- draws a Processing-style preview with audio and servo lanes
- tries to load `../choreographies.json` for examples
- tries to read audio metadata from `../sounds/` for better preview durations

Current simplifications:

- audio clips are shown as duration boxes, not waveforms
- Blockly is loaded from the CDN for now
- this page does not save the full `choreographies.json` file

Serving it locally:

- do not open `index.html` via `file://`
- ES modules and the Blockly CDN script will hit CORS restrictions from a null
  origin
- serve the repo root instead, so relative paths like `../choreographies.json`
  and `../sounds/` keep working
- easiest option: run `./editorv2/serve.sh`
- then open `http://localhost:8000/editorv2/`

For later LiveView integration:

- mount `app.mjs`
- listen for the `editorv2:change` event
- or call `window.LaMachineEditorV2.loadChoreography(...)`
- the backend can provide sound durations instead of relying on browser metadata
