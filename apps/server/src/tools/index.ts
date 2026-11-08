/**
 * Registers all 14 tools. Implemented by: server-core. Tool authors edit only their own file.
 */
import { registerTool } from './registry';
import { get_accountsTool } from './get_accounts';
import { get_forecastTool } from './get_forecast';
import { simulateTool } from './simulate';
import { check_offerTool } from './check_offer';
import { get_termsTool } from './get_terms';
import { read_billTool } from './read_bill';
import { second_opinionTool } from './second_opinion';
import { send_messageTool } from './send_message';
import { send_chartTool } from './send_chart';
import { request_approvalTool } from './request_approval';
import { place_callTool } from './place_call';
import { decideTool } from './decide';
import { post_call_summaryTool } from './post_call_summary';
import { schedule_followupTool } from './schedule_followup';

export function registerAllTools(): void {
  registerTool(get_accountsTool);
  registerTool(get_forecastTool);
  registerTool(simulateTool);
  registerTool(check_offerTool);
  registerTool(get_termsTool);
  registerTool(read_billTool);
  registerTool(second_opinionTool);
  registerTool(send_messageTool);
  registerTool(send_chartTool);
  registerTool(request_approvalTool);
  registerTool(place_callTool);
  registerTool(decideTool);
  registerTool(post_call_summaryTool);
  registerTool(schedule_followupTool);
}

export { runTool, defineTool, getTool } from './registry';
export type { ToolContext, ToolScope, Clock, Engine } from './registry';
