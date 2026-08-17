/**
 * Tiny renderer for the markdown prompt templates in `src/prompts/`.
 *
 * `{{name}}` is substituted from `vars`; an unknown or missing placeholder
 * throws rather than reaching an agent as literal `{{...}}`.
 */
export function render(template: string, vars: Record<string, string> = {}): string {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      const value = vars[name]
      if (value === undefined) {
        throw new Error(`Prompt template placeholder {{${name}}} has no value.`)
      }
      return value
    })
    .trimEnd()
}
