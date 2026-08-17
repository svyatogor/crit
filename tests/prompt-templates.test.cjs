const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs')

const { render } = require('../src/templates.ts')

/**
 * The templates are markdown files inlined by esbuild, so nothing typechecks
 * their placeholders and nothing catches a broken one until an agent is waiting
 * for it. These tests stand in for that.
 */

const promptsDir = path.join(__dirname, '..', 'src', 'prompts')

function template(name) {
  return fs.readFileSync(path.join(promptsDir, `${name}.md`), 'utf-8')
}

test('every prompt template has the sibling that types it', () => {
  // Without it `import x from './prompts/x.md'` fails to compile — an easy
  // thing to forget when adding a template.
  for (const entry of fs.readdirSync(promptsDir)) {
    if (!entry.endsWith('.md')) continue
    const declaration = path.join(promptsDir, `${entry.replace(/\.md$/, '')}.d.md.ts`)
    assert.ok(fs.existsSync(declaration), `${entry} has no .d.md.ts`)
  }
})

test('a review request of one file names it as the slash command argument', () => {
  const rendered = render(template('review-request'), {
    args: ' src/git.ts',
    code: 'crit:v1;aabbccdd;11223344',
  })

  assert.match(rendered, /^\/code-review src\/git\.ts /)
  assert.match(rendered, /crit:v1;aabbccdd;11223344/)
  assert.match(rendered, /mcp__crit__addDiffComment/)
})

test('the review request opens with the slash command on its own first line', () => {
  // Every delivery path sends the same text, but only a first line that starts
  // with `/code-review` expands as a slash command — a preamble above it, or a
  // line break inside it, would send the whole thing as prose.
  const rendered = render(template('review-request'), {
    args: ' src/git.ts',
    code: 'crit:v1;aabbccdd;11223344',
  })

  assert.match(rendered.split('\n')[0], /^\/code-review src\/git\.ts /)
})

test('a project-wide review request leaves no gap where its argument was', () => {
  // Bare `/code-review` reviews the current diff, which is the scope wanted.
  const rendered = render(template('review-request'), {
    args: '',
    code: 'crit:v1;aabbccdd;11223344',
  })

  assert.match(rendered, /^\/code-review — /)
  assert.equal(rendered.includes('  '), false)
})

test('no template reaches an agent with an unfilled placeholder', () => {
  const filled = [
    render(template('review-request'), { args: '', code: 'c' }),
    render(template('nudge-mcp'), { subject: 's', code: 'c' }),
    render(template('nudge-diagnostics'), { subject: 's', label: 'R1', code: 'c' }),
    render(template('review-intro')),
    render(template('review-intro-codes')),
    render(template('review-outro-mcp')),
    render(template('review-outro-tools')),
  ]

  for (const rendered of filled) {
    assert.doesNotMatch(rendered, /\{\{\w+\}\}/)
    assert.ok(rendered.length > 0)
  }
})
