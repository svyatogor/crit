const assert = require('node:assert/strict');
const test = require('node:test');

// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs');

const { addCommentRequestSchema } = require('../src/ipc-server.ts');

/**
 * The wire contract for `POST /comment` — the one endpoint whose caller is a
 * language model rather than this extension's own code.
 */

function parse(body) {
    return addCommentRequestSchema.safeParse(body);
}

function issueFields(result) {
    return result.error.issues.map(issue => issue.path.join('.') || 'request');
}

test('a well-formed request keeps its values and trims the free text', () => {
    const result = parse({
        projectRef: 'aabbccdd',
        file: '  src/git.ts  ',
        startLine: 12,
        text: '  This swallows the error.  ',
    });

    assert.ok(result.success);
    assert.deepEqual(result.data, {
        projectRef: 'aabbccdd',
        file: 'src/git.ts',
        startLine: 12,
        text: 'This swallows the error.',
    });
});

test('endLine is optional, for a finding that sits on one line', () => {
    assert.equal(parse({
        projectRef: 'aabbccdd',
        file: 'src/git.ts',
        startLine: 12,
        text: 'Findings usually name one line.',
    }).success, true);

    assert.equal(parse({
        projectRef: 'aabbccdd',
        file: 'src/git.ts',
        startLine: 12,
        endLine: 20,
        text: 'A finding spanning a range.',
    }).success, true);
});

test('every problem with a request is reported at once', () => {
    // The caller is a model, so one round trip per mistake is a round trip
    // wasted: it must be able to fix everything from a single answer.
    const result = parse({
        projectRef: '',
        file: '   ',
        startLine: 0,
        endLine: 1.5,
        text: '',
    });

    assert.equal(result.success, false);
    assert.deepEqual(
        issueFields(result).sort(),
        ['endLine', 'file', 'projectRef', 'startLine', 'text'],
    );
});

test('lines count from 1 and are whole', () => {
    const base = { projectRef: 'aabbccdd', file: 'src/git.ts', text: 'Finding.' };

    for (const startLine of [0, -1, 1.5, '3', null, undefined, NaN]) {
        const result = parse({ ...base, startLine });
        assert.equal(result.success, false, `startLine ${String(startLine)} must be refused`);
        assert.deepEqual(issueFields(result), ['startLine']);
    }
    assert.equal(parse({ ...base, startLine: 1 }).success, true);
});

test('a body that is not an object at all is named as the problem', () => {
    for (const body of ['nope', 42, null, undefined, []]) {
        const result = parse(body);
        assert.equal(result.success, false, `${JSON.stringify(body) ?? 'undefined'} must be refused`);
        assert.deepEqual(issueFields(result), ['request']);
    }
});
