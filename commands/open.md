---
description: Start the ChibiScope dashboard if needed and open the live agent map
allowed-tools: Bash(node:*)
---

ChibiScope status:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/chibiscope.js" status`

If the status above says the server is running, just tell the user the map is at http://127.0.0.1:4777.
Otherwise start it in the background with `node "${CLAUDE_PLUGIN_ROOT}/bin/chibiscope.js" start --open` (use run_in_background), then confirm it answers on http://127.0.0.1:4777/api/health.
Keep the reply to one or two lines.
