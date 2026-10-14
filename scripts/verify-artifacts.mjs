#!/usr/bin/env node
/**
 * Inspect the packed artefact before publishing.
 *
 * Validating the repository is not validating what `npm publish` would ship:
 * `files` decides what travels, and a missing entry there is invisible until
 * somebody installs the package and finds a dangling reference. The failure mode
 * has a specific shape here — the bundled patch names `dsh-batch-triage`, so if
 * `package.json`'s `name` ever drifts from the patch, the plugin installs and then
 * fails to resolve.
 *
 * Two classes of condition are checked, and the second is the one that keeps
 * being forgotten:
 *
 *  1. **Structure** — the patch exists, it names the package, `files[]` covers
 *     every required file, the entry loads.
 *  2. **Behaviour** — the shipped code still does the thing the README promises.
 *     A package can be structurally perfect and functionally wrong, and this
 *     project's whole subject is things that report success without working. The
 *     smoke checks below run the real prefilter, so a rule table that stopped
 *     matching would fail the artefact check rather than the pub.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checked = []

function check(label, condition, detail = '') {
  checked.push(label)
  if (!condition) failures.push(detail ? `${label}: ${detail}` : label)
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
}

const pkg = readJson('package.json')

// --- the thing that actually breaks installs --------------------------------
const patchPath = pkg.dsh?.bundle?.patch
check('package.json declares dsh.bundle.patch', typeof patchPath === 'string', String(patchPath))
check('manifestVersion is 1', pkg.dsh?.manifestVersion === 1, String(pkg.dsh?.manifestVersion))
check('the patch file exists', existsSync(join(ROOT, patchPath ?? '')), String(patchPath))

const patch = readFileSync(join(ROOT, patchPath), 'utf8')
check(
  'THE PATCH NAMES THE PACKAGE',
  patch.includes(`name: ${pkg.name}`),
  `the patch must mount a module named exactly ${pkg.name}; npm publishes under that `
    + 'name, so a mismatch produces a plugin that installs and then fails to resolve',
)
check('the patch enables the bundle', /insert:/.test(patch))

// Every config key the patch sets must exist in the shipped defaults, or the
// patch is configuring something that does not read it.
for (const key of ['maxItems', 'tau', 'modelStateCap', 'tokenCap', 'failOn', 'timeoutMs',
  'batchSize']) {
  check(`the patch configures ${key}`, new RegExp(`^\\s*${key}:`, 'm').test(patch))
}

// --- engines and identity ---------------------------------------------------
check('engines.node is declared', typeof pkg.engines?.node === 'string')
check('engines.node excludes the EOL lines', !/[<^]?\s*18\./.test(pkg.engines?.node ?? ''))
check('license is declared', typeof pkg.license === 'string' && pkg.license !== '')
check('no runtime dependencies', Object.keys(pkg.dependencies ?? {}).length === 0,
  JSON.stringify(pkg.dependencies))

// --- files that `files` must not drop ---------------------------------------
const REQUIRED = [
  'index.mjs',
  'tools.mjs',
  'lib/config.mjs',
  'lib/errors.mjs',
  'lib/exit.mjs',
  'lib/prefilter.mjs',
  'lib/skill.mjs',
  'lib/triage.mjs',
  'skills/batch-triage/SKILL.md',
  'cordis.patch.yml',
  'README.md',
  'README-zh.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'LICENSE',
]
for (const rel of REQUIRED) {
  check(`file exists: ${rel}`, existsSync(join(ROOT, rel)))
}

const files = pkg.files ?? []
for (const rel of REQUIRED) {
  const covered = files.some((entry) => rel === entry || rel.startsWith(`${entry}/`))
  check(`files[] covers ${rel}`, covered, `"${rel}" would not travel with the package`)
}
check('files[] does not include tests', !files.some((entry) => entry === 'test'))
check('files[] does not include scripts', !files.some((entry) => entry === 'scripts'))
check('files[] declares an explicit allow-list', files.length > 0 && !files.includes('*'))

// --- behaviour the README promises -----------------------------------------
/**
 * One sample per rule id, chosen to trip that rule specifically.
 *
 * Declared before the checks that use it. A `const` further down the file would
 * be in its temporal dead zone at the point of use, and the check would throw
 * rather than fail — which is the "the verifier is broken, not the package"
 * confusion this script exists to avoid.
 */
const SAMPLE_FOR_RULE = {
  outage: 'The service is down for all users',
  data_loss: 'We lost all data after the upgrade',
  security: 'Possible CVE-2026-1234 in the parser',
  crash_with_trace: 'Traceback (most recent call last): boom',
  blocked_workflow: 'I cannot log in and my account is locked',
  regression: 'This used to work before the update',
  wrong_result: 'It gives the wrong answer for negative numbers',
  performance: 'The export takes 40 minutes now',
  flaky: 'This is intermittent, it only fails sometimes',
  install_question: 'How do I install this on Windows?',
  usage_question: 'Is it possible to export as CSV?',
  documentation: 'The documentation is outdated',
  feature_request: 'Feature request: please add CSV export',
  thanks: 'Thanks!',
}

try {
  // `pathToFileURL`, not the bare path: on Windows an absolute path is `D:\...`,
  // which the ESM loader rejects outright.
  const mod = await import(pathToFileURL(join(ROOT, 'index.mjs')).href)
  check('index.mjs exports createPlugin', typeof mod.createPlugin === 'function')
  check('BUNDLE_NAME matches package.json', mod.BUNDLE_NAME === pkg.name,
    `${mod.BUNDLE_NAME} vs ${pkg.name}`)

  let threw = null
  try {
    mod.createPlugin(null, {})
  } catch (error) {
    threw = error
  }
  check('createPlugin refuses a ctx with no .inject()', threw !== null)

  const config = mod.resolveConfig({})

  // The claim the README leads with: a rule decides clear cases.
  const urgent = mod.prefilter({ id: 'x', text: 'The service is down for all users' }, config)
  check('the prefilter still recognises an outage', urgent.class === 'urgent',
    `${urgent.class} / ${urgent.reason}`)

  // The claim that matters most: nothing unclassified is called routine.
  for (const text of ['blorp spang wibble', '', '   ']) {
    const verdict = mod.prefilter({ id: 'x', text }, config)
    check(`an unclassifiable item is not routine (${JSON.stringify(text)})`,
      verdict.class !== 'routine', `${verdict.class} / ${verdict.reason}`)
  }

  // The same promise in its harder form, and the one 0.1.1 shipped green while it was
  // false: a question-shaped ticket whose *other* sentence reports a malfunction must
  // not be settled by the question rule. The wording is deliberately outside every
  // severity rule's vocabulary — "throws an error" is not a traceback, an outage noun
  // or an incorrect result — because a sample a severity rule can claim tests that
  // rule rather than this guard. Remove `guardRoutine` and this becomes `routine`,
  // which is the exit-0 fail-open the unit suite pins from the other side.
  const hidden = mod.prefilter({
    id: 'x',
    text: 'How do I install this? The dashboard throws an error whenever I open it.',
  }, config)
  check('A QUESTION CANNOT SWALLOW A MALFUNCTION IT DOES NOT RECOGNISE',
    hidden.class !== 'routine', `${hidden.class} / ${hidden.reason}`)

  // Every rule must be able to fire. A rule that cannot match is indistinguishable
  // from a rule that found nothing, so each one is exercised with wording it
  // declares it recognises.
  for (const rule of mod.PREFILTER_RULES) {
    const sample = SAMPLE_FOR_RULE[rule.id]
    if (sample === undefined) {
      failures.push(`no artefact-check sample for rule ${rule.id}: a rule with no positive `
        + 'case cannot be told apart from a rule that never fires')
      checked.push(`sample exists for ${rule.id}`)
      continue
    }
    const verdict = mod.prefilter({ id: 'x', text: sample }, config)
    check(`rule ${rule.id} can fire`, verdict.reason === rule.reason,
      `sample ${JSON.stringify(sample)} gave ${verdict.reason}`)
  }
} catch (error) {
  check('index.mjs imports cleanly', false, String(error && error.message))
}

// --- report -----------------------------------------------------------------
console.log(`inspecting ${pkg.name}@${pkg.version} at ${ROOT}`)
console.log(`checked ${checked.length} conditions`)
if (failures.length === 0) {
  console.log('OK: the packed artefact would carry every file the patch needs, the patch '
    + 'names the package, the entry loads, and every rule can still fire')
  process.exit(0)
}
console.log('')
for (const failure of failures) console.log(`FAIL ${failure}`)
process.exit(1)
