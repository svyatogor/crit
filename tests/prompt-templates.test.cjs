const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs');

const { render, singleLine } = require('../src/templates.ts');

/**
 * The templates are markdown files inlined by esbuild, so nothing typechecks
 * their placeholders and nothing catches a template that cannot be flattened for
 * the terminal until an agent is waiting for it. These tests stand in for that.
 */

const promptsDir = path.join(__dirname, '..', 'src', 'prompts');

function template(name) {
    return fs.readFileSync(path.join(promptsDir, `${name}.md`), 'utf-8');
}

test('every prompt template has the sibling that types it', () => {
    // Without it `import x from './prompts/x.md'` fails to compile — an easy
    // thing to forget when adding a template.
    for (const entry of fs.readdirSync(promptsDir)) {
        if (!entry.endsWith('.md')) continue;
        const declaration = path.join(promptsDir, `${entry.replace(/\.md$/, '')}.d.md.ts`);
        assert.ok(fs.existsSync(declaration), `${entry} has no .d.md.ts`);
    }
});

test('a review request of one file names it as the slash command argument', () => {
    const rendered = render(template('review-request'), {
        args: ' src/git.ts',
        code: 'crit:v1;aabbccdd;11223344',
    });

    assert.match(rendered, /^\/code-review src\/git\.ts /);
    assert.match(rendered, /crit:v1;aabbccdd;11223344/);
    assert.match(rendered, /mcp__crit__addDiffComment/);
});

test('the review request reaches the terminal as one submittable line', () => {
    // `Terminal.sendText` submits on every newline, so a second line would send
    // the instructions as a separate prompt — or as shell input. The other two
    // delivery paths keep the line breaks; only this one has to be flat.
    const rendered = singleLine(render(template('review-request'), {
        args: ' src/git.ts',
        code: 'crit:v1;aabbccdd;11223344',
    }));

    assert.equal(rendered.includes('\n'), false);
    assert.match(rendered, /^\/code-review src\/git\.ts /);
});

test('a project-wide review request leaves no gap where its argument was', () => {
    // Bare `/code-review` reviews the current diff, which is the scope wanted.
    const rendered = singleLine(render(template('review-request'), {
        args: '',
        code: 'crit:v1;aabbccdd;11223344',
    }));

    assert.match(rendered, /^\/code-review — /);
    assert.equal(rendered.includes('  '), false);
});

test('no template reaches an agent with an unfilled placeholder', () => {
    const filled = [
        render(template('review-request'), { args: '', code: 'c' }),
        render(template('nudge-mcp'), { subject: 's', code: 'c' }),
        singleLine(render(template('nudge-diagnostics'), { subject: 's', label: 'R1', code: 'c' })),
        render(template('review-intro')),
        render(template('review-intro-codes')),
        render(template('review-outro-mcp')),
        render(template('review-outro-tools')),
    ];

    for (const rendered of filled) {
        assert.doesNotMatch(rendered, /\{\{\w+\}\}/);
        assert.ok(rendered.length > 0);
    }
});
