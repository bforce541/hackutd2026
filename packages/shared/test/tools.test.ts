import { describe, expect, it } from 'vitest';
import { MODEL_TOOL_NAMES, TOOLS, TOOL_NAMES, toOpenAITool } from '../src/tools';
import { ChangeSchema, PlannerOutputSchema } from '../src/schemas';

describe('tool schemas', () => {
  it('defines all 14 tools', () => {
    expect(TOOL_NAMES).toHaveLength(14);
    for (const n of TOOL_NAMES) expect(TOOLS[n].name).toBe(n);
  });
  it('turns every model-callable tool into a JSON schema', () => {
    for (const n of MODEL_TOOL_NAMES) {
      const t = toOpenAITool(n);
      expect(t.function.name).toBe(n);
      expect(t.function.parameters.type).toBe('object');
    }
    expect(MODEL_TOOL_NAMES).not.toContain('check_offer');
    expect(MODEL_TOOL_NAMES).not.toContain('decide');
  });
  it('validates inputs', () => {
    expect(TOOLS.check_offer.input.safeParse({ itemId: 'auto', newDay: 6, fee: 2000 }).success).toBe(true);
    expect(TOOLS.check_offer.input.safeParse({ itemId: 'auto', newDay: 6, fee: 20.5 }).success).toBe(false);
    expect(ChangeSchema.safeParse({ type: 'move_item', itemId: 'auto', toDay: 6 }).success).toBe(true);
    expect(PlannerOutputSchema.safeParse({ goal: 'x', steps: [{ kind: 'forecast', title: 't', model: 'engine' }] }).success).toBe(true);
  });
});
