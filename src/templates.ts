/**
 * Tiny renderer for the markdown prompt templates in `src/prompts/`.
 *
 * `{{name}}` is substituted from `vars`; an unknown or missing placeholder
 * throws rather than reaching an agent as literal `{{...}}`.
 */
export function render(template: string, vars: Record<string, string> = {}): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
        const value = vars[name];
        if (value === undefined) {
            throw new Error(`Prompt template placeholder {{${name}}} has no value.`);
        }
        return value;
    }).trimEnd();
}

/**
 * Collapse a template to a single line.
 *
 * `Terminal.sendText` submits on every newline, so a prompt bound for the
 * terminal must arrive as one line — but authoring it that way is unreadable.
 * Templates for that path are wrapped normally and flattened here; blank lines
 * become paragraph breaks that a single line cannot express, so they are an
 * authoring mistake and throw.
 */
export function singleLine(text: string): string {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length !== text.trim().split('\n').length) {
        throw new Error('A single-line prompt template must not contain blank lines.');
    }
    return lines.join(' ');
}
