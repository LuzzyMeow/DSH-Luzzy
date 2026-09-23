/**
 * LuzzyMode's persona row — the prompt that comes from the LuzzyPage sub-page, not from
 * this file.
 *
 * HOW A PROMPT REACHES THE MODEL
 *
 * The section text is the constant reference `{{luzzy_persona}}`; the value is supplied by
 * a prompt VARIABLE whose provider reads the store on every assembly. That split is
 * load-bearing twice over:
 *
 *   * The variable's VALUE is substituted verbatim and never re-scanned, so a user prompt
 *     containing its own `{{...}}` examples cannot break rendering. Section text IS
 *     re-scanned, and an unknown reference throws — putting user text there would turn a
 *     stray brace into a failed request.
 *   * The provider runs per step, so an edit shows up on the next request. No restart, no
 *     re-mount, no preset switch.
 *
 * WHY A ROW INSTEAD OF THE TEXT
 *
 * `@deepseek-ai/dsh-persona` takes its prefix as CONFIG, which is fixed at mount time; a
 * preset that mounted it could never change its identity without being edited on disk and
 * remounted. This row keeps the same section name and order — so it still shadows the
 * deployment persona — but the text is resolved per assembly instead.
 *
 * WHY THIS BEATS SWITCHING PRESETS
 *
 * `agent-presets` locks a session's preset as soon as it has produced anything. Switching
 * the ACTIVE AGENT only changes which file this reader resolves, which is not a preset
 * change, so it takes effect mid-conversation — the behaviour the sub-page promises.
 *
 * @module dsh-luzzy-preset/persona
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPromptReader, resolveDshHome, storePaths } from './preset-store.mjs'

/** Cordis plugin name. */
export const name = 'luzzy-persona'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/**
 * Section names owned by the prompt registry.
 *
 * Sourced from `@deepseek-ai/dsh-system-prompt` (PERSONA_PREFIX_SECTION /
 * PERSONA_SUFFIX_SECTION). They are written out rather than imported because this preset
 * is copied into `~/.dsh/.agent-presets/`, where the only hard requirement is that it
 * mounts; an extra package import is one more way for the whole preset to be reported
 * broken at roster time. Both names are part of the registry's published contract — the
 * shipped presets and `dsh-persona` itself register under exactly these strings.
 */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'
const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'

/** The variable name this row registers and references. Must match `[a-z][a-z0-9_]*`. */
const PERSONA_VARIABLE = 'luzzy_persona'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The bundled last resort, read only when the store and its default file both fail. */
const BUILTIN_FALLBACK = join(HERE, 'default-prompt.md')

/**
 * Register the persona section, its variable, and the suffix.
 *
 * Registration order matters in one direction only: the variable is registered BEFORE the
 * section that references it. Both land in this preset's scope, so the section is never
 * assembled without its value — and an ordering that would throw on every request is not
 * worth relying on being impossible.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the preset's standing scope.
 */
export function apply(ctx) {
  const paths = storePaths(resolveDshHome())
  const reader = createPromptReader(paths, { builtinFallbackPath: BUILTIN_FALLBACK })

  ctx.effect(
    () => ctx.systemPrompt.variable(PERSONA_VARIABLE, () => reader.read().text),
    'luzzy-preset: persona variable',
  )

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: `{{${PERSONA_VARIABLE}}}`,
      }),
    'luzzy-preset: persona section',
  )

  // The workspace line the shipped `standard` preset carries. Kept so a LuzzyMode session
  // is told where it operates, exactly as a standard one is.
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PERSONA_SUFFIX_SECTION,
        order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        text: 'Your working directory is {{cwd}}.',
      }),
    'luzzy-preset: persona suffix',
  )
}
