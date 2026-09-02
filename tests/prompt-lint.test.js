// Static lint over tests/smoke.spec.js — guarantees every "Use the X
// tool" / "Call the X tool" reference in an assistant prompt names a
// tool the server actually OFFERS. Runs as a regular `node --test`
// suite (no Playwright, no browser, ~10 ms): if a tool gets renamed or
// withdrawn, this fails before anyone discovers it via a 15-minute
// promote gate.
//
// It did not, once, and that is the reason it looks like this. The
// catalog below used to mirror `mistral_client.py` — a file that no
// longer exists — and listed `propose_edit` plus five generated
// endpoints that were deliberately withdrawn from the offered surface.
// So the lint went on approving prompts that ordered the model to call
// a tool it had never been given. On 2026-09-01 the promote gate spent
// fifteen minutes on ASSIST-25 before failing it: told to use
// propose_edit, the model had nothing to call and wandered until the
// 200s stream deadline. The lint that exists to prevent exactly that
// was green.
//
// A stale guard is worse than no guard: it answers the question you
// meant to ask with the wrong data and looks like coverage. Hence the
// pointers below name files, symbols AND the reason each list exists,
// so the next person renaming a tool can find every place to change.
//
// The pinned catalog MUST mirror what the server offers:
//   - `OFFERED_BUILTINS` in fontem-community-api
//     src/assistant/engine_tools.py — the built-ins the model is given.
//     NOT `_TOOLS` in tool_runtime.py: that is what is IMPLEMENTED, and
//     it still carries retired verbs (propose_edit, find_paths) so that
//     saved conversations keep rendering. Implemented ≠ offered, and
//     the prompts must name the offered set.
//   - `OFFERED_GENERATED` in the same file (get_doc, get_schema).
//   - `STUDIO_TOOLS` in src/assistant/studio_tools.py.
//   - `NAVIGATE_TOOL_NAME` in src/assistant/navigation.py.
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

// The names as a prompt writes them — the server's mcp__gmr__ prefix is
// an implementation detail the model's tool array carries, not
// something a person types into a sentence.
const OFFERED_TOOLS = new Set([
  // engine_tools.OFFERED_BUILTINS
  'search_entities',
  'investigate_entity',
  'read_document',
  'set_title',
  'set_abstract',
  'replace_body',
  'insert_widget',
  'insert_studio_plot',
  'query_graph',
  'calculate',
  // engine_tools.OFFERED_GENERATED
  'get_doc',
  'get_schema',
  // navigation.NAVIGATE_TOOL_NAME
  'navigate',
  // studio_tools.STUDIO_TOOLS
  'studio_list_projects',
  'studio_get_project',
  'studio_create_project',
  'studio_rename_project',
  'studio_add_query',
  'studio_update_query',
  'studio_run_query',
  'studio_add_plot',
  'studio_update_plot',
])

// Retired: implemented for stored conversations, never offered. Naming
// one in a prompt is the specific mistake this file exists to catch, so
// it earns its own message rather than "unknown tool".
const RETIRED_TOOLS = new Set(['propose_edit', 'find_paths'])

/** The spec with its commentary removed.
 *
 * Comments discuss retired tools on purpose — the history of why
 * propose_edit went away is worth keeping next to the tests it shaped.
 * Only what reaches the model is linted. */
function promptSource(source) {
  return source.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

/** Every tool named in an instruction to the model. */
function toolReferences(source) {
  return [...promptSource(source).matchAll(/(?:Use|Call) the ([a-z_]+) tool/g)]
    .map((m) => m[1])
}

/** Retired names anywhere in a prompt, including the bare "Use propose_edit"
 *  phrasing that the "the X tool" pattern above does not match — ASSIST-25
 *  was written that way and slipped past the first version of this lint. */
function retiredMentions(source) {
  const text = promptSource(source)
  return [...RETIRED_TOOLS].filter((t) => new RegExp(`\\b${t}\\b`).test(text))
}

describe('smoke prompt tool references', () => {
  it('names at least one tool — the spec has not moved out from under us', () => {
    assert.ok(toolReferences(SMOKE_SPEC).length > 0,
      'no "Use/Call the X tool" references found — did the smoke spec move?')
  })

  it('never orders the model to call a retired tool', () => {
    const retired = retiredMentions(SMOKE_SPEC)
    assert.deepEqual(retired, [],
      `smoke prompts name retired tool(s): ${retired.join(', ')}. These are `
      + `implemented but NOT offered (see OFFERED_BUILTINS in `
      + `fontem-community-api src/assistant/engine_tools.py), so the model `
      + `cannot call them: it will wander until the stream deadline and the `
      + `gate will fail on a timeout that looks like slowness. Name a tool `
      + `from the offered set instead.`)
  })

  it('every "Use/Call the X tool" reference names an offered tool', () => {
    const unknown = [...new Set(toolReferences(SMOKE_SPEC))]
      .filter((t) => !OFFERED_TOOLS.has(t) && !RETIRED_TOOLS.has(t))
    assert.deepEqual(unknown, [],
      `Tool(s) named in smoke prompts but not offered by the server: `
      + `${unknown.join(', ')}. Mirror the canonical name from `
      + `fontem-community-api src/assistant/engine_tools.py `
      + `(OFFERED_BUILTINS / OFFERED_GENERATED), studio_tools.py or `
      + `navigation.py into OFFERED_TOOLS here, or fix the prompt.`)
  })

  it('no prompt still passes a propose_edit action= argument', () => {
    // propose_edit took `action="insert_content"` and friends. The verbs
    // that replaced it each take their own parameters, so a surviving
    // action= is a prompt that was never migrated.
    const actions = [...promptSource(SMOKE_SPEC).matchAll(/action="([a-z_]+)"/g)]
      .map((m) => m[1])
    assert.deepEqual(actions, [],
      `smoke prompts still pass propose_edit action(s): `
      + `${[...new Set(actions)].join(', ')}. propose_edit is retired; use `
      + `set_title / set_abstract / replace_body / insert_widget, each of `
      + `which takes its own arguments.`)
  })
})
