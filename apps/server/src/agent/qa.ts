/**
 * Q&A: answer_question for TEXT events and the inbound call's /ask (SPEC §5.1, §7.4).
 * Super with read-only tools (QA_TOOL_NAMES); numbers only from tool results. Implemented by: model-tools.
 */
import type { ToolContext } from '../tools/registry';

export async function answerQuestion(
  _ctx: ToolContext,
  _question: string,
  _opts: { channel: 'imessage' | 'dashboard' | 'voice'; allowNumbers: boolean },
): Promise<string> {
  throw new Error('agent.answerQuestion: not implemented yet');
}
