# apps/server ownership

Each file has one owner (a build stream). Edit only the files your stream owns. If you need a change in someone else's file or in `packages/shared`, say so in your report instead of editing it.

Every stub throws or returns a `not implemented yet` error until its owner fills it in. Contracts (interfaces, signatures, the transition table) are fixed; implement behind them.

| Path | Stream | What it is |
|---|---|---|
| `src/index.ts` | server-core | Boot: store, bus, models, messaging, tools, agent, watcher, HTTP on 8787. Already hands every inbound iMessage (photo fetched) to `messaging/router.ts`; photon does not edit it |
| `src/app.ts` | server-core | Hono app, CORS, error shape, `/api/health`, mounts every router at `/api` |
| `src/context.ts` | server-core | `ServerContext` (ToolContext + agent, watcher, loadHousehold) |
| `src/env.ts`, `src/ids.ts` | server-core | Typed env access (never log values), id and time helpers |
| `src/bus.ts` | server-core | `emit` (activity), `publish` (SSE), `subscribe`, `since` (Last-Event-ID replay) |
| `src/store/` | server-core | `Store` interface, in-memory state, snapshot to `data/state.json`, media bytes in `data/media/`. `forecastChanges()` is the one list of changes every forecast applies |
| `src/forecast.ts` | server-core (done) | `currentForecast`, `currentScores`, `currentNetWorth`, `publishForecast`: every reader's numbers |
| `src/messaging/outbox.ts` | server-core (done) | `sendText`, `sendImage`, `recordInbound`: the only path into the thread; quiet hours and Pause for unprompted texts |
| `src/approvals.ts` | server-core (done) | `pendingApproval`, `resolveApproval`, `timeoutApproval`: the only writers of an approval's status |
| `fixtures/brake_quote.png` | server-core (done) | The repair quote photo for `POST /api/demo/bill-photo { fixture: 'brake_quote' }` |
| `src/api/http.ts` | server-core | Error shape, `parseBody`, `localOnly` guard |
| `src/api/household.ts` | server-core | household, forecast, scores, simulate, rules |
| `src/api/thread.ts` | server-core | `GET/POST /thread` (POST goes through `messaging/router.ts`) |
| `src/api/cases.ts` | server-core | `cases/current`, `calls/:id`, `approvals/:id` (addition), `snapshot` (addition) |
| `src/api/demo.ts` | server-core | reset, clock, bill-photo, customer-says, fail-call (addition) |
| `src/api/events.ts` | server-core | SSE stream |
| `src/api/media.ts` | server-core | `GET /media/:id` |
| `src/tools/registry.ts`, `src/tools/index.ts` | server-core | `ToolContext`, `defineTool`, `runTool` (zod + tool.called/tool.result), registration |
| `src/messaging/port.ts`, `src/messaging/console.ts` | server-core | `MessagingPort` (SPEC §6) and the print-only adapter |
| `src/prompts/load.ts` | server-core | `loadPrompt(name, vars)` |
| `src/models/` | models | `ModelClient`: gateway.ts + nvidia.ts behind `createModelClient`, timeouts, one retry, `model.called` per call |
| `src/agent/stub.ts` | agent-stub | Scripted agent: the repair case with UI.md's exact texts, no model calls |
| `src/messaging/photon.ts` | photon | Photon 2.0 adapter (poll, send text and images, fetch photos) |
| `src/messaging/router.ts` | photon | Message from Yoshua -> thread + `AgentEvent` (uses `parseReply` from shared) |
| `src/tools/get_accounts.ts`, `get_forecast.ts`, `simulate.ts`, `check_offer.ts`, `send_message.ts`, `send_chart.ts`, `request_approval.ts`, `place_call.ts`, `schedule_followup.ts` | tools-code | Tools without a model (facts check in send_message; approval timeouts; place_call gates and SipCallError -> CALL_FAILED) |
| `src/messaging/chart.ts` | tools-code | 1200 x 800 chart PNG with resvg |
| `src/agent/index.ts` | server-core (interface), agent-core (real branch) | `Agent`, `createAgent(ctx, { mode })` |
| `src/agent/orchestrator.ts`, `planner.ts`, `machine.ts` | agent-core | Real agent, planner + validation + template plans, state machine and gates. `placeCallBlockers()` in machine.ts is already written and used by `tools/place_call.ts`; agent-core may extend it but keeps its signature |
| `src/prompts/planner.md`, `orchestrator.md` | agent-core | Prompts (SPEC §8.1, §8.2) |
| `src/agent/negotiator.ts`, `src/tools/decide.ts` | negotiator | `decide` (SPEC §5.6), read-back, counters, deal approval |
| `src/api/negotiations.ts` | negotiator | Lender console endpoints |
| `src/prompts/negotiator.md` | negotiator | Prompt (SPEC §8.3) |
| `src/tools/read_bill.ts`, `second_opinion.ts`, `get_terms.ts`, `post_call_summary.ts` | model-tools | Tools with a model |
| `src/agent/secondOpinion.ts`, `src/agent/qa.ts` | model-tools | Claude review; Q&A for TEXT and inbound `/ask` |
| `src/prompts/second-opinion.md` | model-tools | Prompt (SPEC §8.5) |
| `packages/engine/fixtures/terms/*.md` | model-tools | Loan and card terms for `get_terms` (Ram's, inside Yoshua's package) |
| `src/agent/watcher.ts` | watcher | Daily check, CD_MATURING, SHORTFALL, follow-ups, 30-minute reminders |
| `src/voice/dispatch.ts` | voice | LiveKit dispatch + SIP participant, hang up |
| `src/api/voice.ts` | voice | Voice worker endpoints (localhost only) |
| `apps/voice/` | voice | The LiveKit Agents worker |
| `src/agent/arena.ts`, `src/api/arena.ts`, `src/scripts/arena.ts` | arena | Arena runs, grading, results |
| `src/prompts/arena-lender.md`, `arena-grader.md` | arena | Prompts (SPEC §8.6, §8.7) |
| `src/scripts/demo-e2e.ts` | demo-e2e | `pnpm demo:e2e` (SPEC §11) |

## Rules for every stream

- Texts to Yoshua go through `messaging/outbox.ts` (directly, or via the `send_message` / `send_chart` / `request_approval` tools). Never call `ctx.messaging` or `store.appendMessage` yourself.
- Approval status changes only through `approvals.ts`. Forecast numbers only through `forecast.ts`, so the dashboard, tools and texts agree.
- Messages from Yoshua (iMessage, coach chat, demo injections, dashboard approval buttons) all go through `messaging/router.ts` `routeIncoming`, which records, classifies, resolves approvals and enqueues the event. Callers never enqueue its result.
- Fixture ids (accounts, scheduled items, the auto lender) come from `ACCOUNT_IDS`, `ITEM_IDS` and `COUNTERPARTY_IDS` in `@pacepay/shared`; a bill's payment is the `add_item` with id `billItemId(bill.id)` in `case.baseChanges`.

- Types, schemas, tool schemas, event names, templates and the formatter come from `@pacepay/shared`. Do not redefine them locally.
- Money is integer cents; days are demo days. Format with `formatMoney` / `formatDate` from shared.
- Every agent step emits an activity event through `ctx.bus.emit` (SPEC rule 4). Tools get theirs from `runTool`.
- No new dependencies. Everything needed is installed; ask the lead if something is missing.
- Run code that needs keys from the repo root with `npx @dotenvx/dotenvx run --convention=nextjs -- <cmd>`. Never print secret values.
- Check your work with `pnpm --filter @pacepay/server typecheck` and `pnpm --filter @pacepay/server test`.
