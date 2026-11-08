/**
 * Loads a prompt file and fills {{double_braces}} variables. Implemented by: server-core.
 * Throws when a variable in the file has no value, so a typo cannot reach a model.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

export type PromptName = 'planner' | 'orchestrator' | 'negotiator' | 'second-opinion' | 'arena-lender' | 'arena-grader';

export function loadPrompt(name: PromptName, vars: Record<string, string | number>): string {
  const raw = readFileSync(join(dir, `${name}.md`), 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '');
  return raw.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`prompt ${name}: missing {{${key}}}`);
    return String(v);
  });
}
