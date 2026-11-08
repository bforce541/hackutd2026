/**
 * Tool `get_accounts` (SPEC §5.6). Implemented by: tools-code.
 * Accounts after store.forecastChanges() (engine.applyChanges), grouped by CATEGORIES order;
 * netWorth from ../forecast.ts currentNetWorth.
 */
import { CATEGORIES, TOOLS, type Account, type Category } from '@pacepay/shared';
import { currentNetWorth } from '../forecast';
import { defineTool } from './registry';

export const get_accountsTool = defineTool('get_accounts', TOOLS.get_accounts.input, TOOLS.get_accounts.output, async (_input, ctx) => {
  const applied = ctx.engine.applyChanges(ctx.store.household(), ctx.store.forecastChanges());
  const byCategory = {} as Record<Category, Account[]>;
  for (const c of CATEGORIES) byCategory[c] = applied.accounts.filter((a) => a.category === c);
  return { byCategory, netWorth: currentNetWorth(ctx) };
});
