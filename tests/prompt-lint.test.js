// Static lint over tests/smoke.spec.js — guarantees every "Use the X
// tool" / `action="X"` reference in an assistant prompt names a tool
// that actually exists on the server. Runs as a regular `node --test`
// suite (no Playwright, no browser, ~10 ms): if a tool gets renamed
// or removed, this test fails before anyone discovers it via a
// 5-minute staging smoke run.
//
// Concretely: the migration of `set_title` → `propose_edit/update_title`
// was the bug class this guards against. The assistant correctly
// refuses unknown tool names — that's the right behaviour, not a bug —
// but it costs us a full smoke run, a retry, and a debugging round
// trip every time the prompt drifts. This test catches it locally.
//
// The pinned catalogs below MUST mirror their source-of-truth files.
// When the assistant adds or renames a tool, mirror it here:
//   - `PROPOSE_EDIT_ACTIONS` in fontem-community-api
//     src/assistant/mistral_client.py
//   - The MCP tool names declared in the `_TOOLS` list in
//     fontem-community-api src/assistant/mistral_client.py
//
// We mirror by hand (a few strings) rather than vendoring across repos
// because the catalogs change rarely and a cross-repo build step would
// be heavier than the bug we're guarding against.
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SMOKE_SPEC = readFileSync(join(HERE, 'smoke.spec.js'), 'utf8')

// Mirrors PROPOSE_EDIT_ACTIONS in fontem-community-api
// src/assistant/mistral_client.py (the enum the model sees inside
// the propose_edit tool definition).
const PROPOSE_EDIT_ACTIONS = new Set([
  'insert_content',
  'insert_widget',
  'update_title',
  'update_abstract',
])

// Tool names the assistant exposes — propose_edit (edit proposals) +
// the MCP graph tools. Mirror of mcp__gmr__* names in
// fontem-community-api src/assistant/mistral_client.py's `_TOOLS`.
const ASSISTANT_TOOL_NAMES = new Set([
  'propose_edit',
  'search_entities',
  'investigate_entity',
  'get_company',
  'get_authority',
  'get_contracts',
  'get_path',
])

describe('smoke prompt tool references', () => {
  it('every action="…" in a prompt names a real propose_edit action', () => {
    const actionRefs = [...SMOKE_SPEC.matchAll(/action="([a-z_]+)"/g)]
      .map((m) => m[1])
    assert.ok(actionRefs.length > 0,
      'no action="…" references found — did the smoke spec move?')
    const unknown = actionRefs.filter((a) => !PROPOSE_EDIT_ACTIONS.has(a))
    assert.deepEqual(unknown, [],
      `propose_edit action(s) referenced in smoke prompts but not in ` +
      `PROPOSE_EDIT_ACTIONS: ${[...new Set(unknown)].join(', ')}. ` +
      `Either the smoke prompt is stale (most common) or the canonical ` +
      `enum in fontem-community-api/src/assistant/mistral_client.py ` +
      `gained a new action — mirror it into PROPOSE_EDIT_ACTIONS in ` +
      `tests/prompt-lint.test.js.`)
  })

  it('every "Use the X tool" reference names a real assistant tool', () => {
    const toolRefs = [...SMOKE_SPEC.matchAll(/Use the ([a-z_]+) tool/g)]
      .map((m) => m[1])
    assert.ok(toolRefs.length > 0,
      'no "Use the X tool" references found — did the smoke spec move?')
    const unknown = toolRefs.filter((t) => !ASSISTANT_TOOL_NAMES.has(t))
    assert.deepEqual(unknown, [],
      `Tool(s) named in smoke prompts but not in ASSISTANT_TOOL_NAMES: ` +
      `${[...new Set(unknown)].join(', ')}. Mirror the canonical name ` +
      `from fontem-community-api/src/assistant/mistral_client.py's ` +
      `_TOOLS into ASSISTANT_TOOL_NAMES in tests/prompt-lint.test.js, ` +
      `or fix the prompt to use a real tool name.`)
  })
})
