import type { z } from 'zod';
import type { ToolDef } from '../../../framework/runtime/types';
import type { AgentCtx } from './context';

/** Typed helper so each tool keeps its own input/output types while the registry is uniform. */
export type AnyTool = ToolDef<AgentCtx, unknown, unknown>;

export function defineTool<I, O>(def: {
  name: string;
  description: string;
  input: z.ZodType<I>;
  inputClass?: string;
  outputClass?: string;
  permission: string | null;
  effect?: 'read' | 'propose' | 'dispatch';
  untrustedFields?: string[];
  handler: (ctx: AgentCtx, input: I) => Promise<O>;
}): AnyTool {
  return { effect: 'read', ...def } as unknown as AnyTool;
}
