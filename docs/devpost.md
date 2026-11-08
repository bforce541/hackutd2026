# PacePay

**A money assistant you save as a contact. It texts you before money gets tight, and with your OK, calls whoever you owe to fix it.**

## Inspiration

Bills and paychecks that don't line up cause overdrafts and late fees. The fix is often one phone call: lenders really do move due dates. But nobody makes the call, and no budgeting app can.

Most tools show you a chart. We wanted one that acts. So we built the dashboard, and an agent that acts on what the dashboard finds.

## What it does

Yoshua (our demo household) has eight accounts: checking, savings, a CD, a Roth IRA, a car loan, a personal loan, a credit card and a mortgage. He sets three rules: keep $100 in checking, keep $1,500 in savings, pay no more than $25 in fees.

1. The shop quotes $650 for brakes. Yoshua texts PacePay a photo of the quote, with no question.
2. PacePay reads the bill, replies in seconds, and sends a chart of the week: checking hits **−$300 on Tuesday** if he pays today.
3. It texts three options, with a pick and a reason. Yoshua replies "1": ask the lender to move the car payment to Friday.
4. Yoshua OKs the limits ($25 max in fees). PacePay gets a second opinion on the plan, then calls the lender.
5. On the call it says it's an AI assistant calling with Yoshua's permission, and that the call is transcribed. The lender offers Wednesday. PacePay declines without giving a reason, because Wednesday is still before payday, and asks for Friday. They settle on Friday for $20.
6. Mid-call, Yoshua's phone buzzes: "They'll move it to Fri, Nov 13 for $20. Approve?" He replies YES, and PacePay confirms on the call.
7. A done text lands in the thread. Checking stays at $100 or above, and the forecast turns green.
8. Without being asked, PacePay points out that the new Friday date only works if Thursday's paycheck lands (late, checking would hit −$320 on Friday) and watches for it unless he says no. When he says the paycheck really is late, it offers the options again, call first: move the car payment again to Tuesday.
9. Later, unprompted: the $5,000 CD matures Fri, Nov 20. PacePay compares paying off the card ($2,214) and saving the rest against renewing. Paying off the card saves about $550 a year.

The **web dashboard** shows all eight accounts with net worth, four health scores (cash cushion, emergency fund, credit use, debt-to-income), a 60-day forecast, a what-if panel, the coach chat, an Activity feed of every agent step, and a negotiation Arena.

PacePay never moves money or agrees to anything final without Yoshua's yes.

## How we built it

Everything is TypeScript, so one calculator is shared by every piece.

| Piece | Model or tool | What it does |
|---|---|---|
| Forecast engine | None. Plain code. | All the math: daily balances, health scores, what-ifs, `check_offer`. Deterministic and unit-tested. Runs in the browser too. No model ever calculates a number. |
| Planner | Nemotron 3 Ultra | Writes the step plan for each event, plans calls, writes the CD advice |
| Orchestrator | Nemotron 3 Super | Carries out the plan with tools, ranks the options |
| Call decisions | Nemotron 3 Super | Decides every response to an offer through a `decide` tool |
| Bill reader | Nemotron Nano 2 VL | Reads bill photos. Claude cross-checks the amount and due date. |
| Second opinion | Claude Opus 5.5 | A different model family checks the call plan against Yoshua's rules before PacePay dials |
| Grading | Claude Opus 5.5 | Grades every arena transcript |
| Simulated lenders | Nemotron 3 Ultra | Plays 50 lender personalities |
| Call voice | GPT realtime (`gpt-realtime-2.1`) via LiveKit on the Photon number | Hearing, speaking, turn-taking |
| Texting | Photon 2.0 iMessage (`spectrum-ts`) | Proactive texts, options, approvals, chart images, bill photos |
| Dashboard | Next.js, shadcn/ui, visx | Live updates over server-sent events |
| Charts in texts | Rendered from engine data | Never AI-generated. Numbers in a picture have to be exact. |

Nemotron makes every decision. Claude checks and grades. GPT is only the voice. Code does the math.

**On lender calls, the voice model never sees balances or limits.** It knows Yoshua's name, the loan reference, and the line Nemotron hands it. For every offer it calls Nemotron's `decide` tool and says what comes back.

Code enforces the hard gates: no call without Yoshua's pick and his OK on the limits, no deal without his yes, and every offer goes through `check_offer`. Offers are judged by the engine, not a model. A payment on payday counts as risky, because the deposit might land after the payment.

## PNC: 360° Financial Health Navigator

| PNC asks for | How PacePay does it |
|---|---|
| The whole picture | One household with all eight accounts and net worth |
| 3+ health indicators | Four scores, each with a goal, a one-line reason, and how to improve |
| Forecast balances and obligations | 60-day daily forecast with every bill and paycheck |
| A "what if" simulator | What-if panel, and what-ifs by text |
| A conversational coach | The same assistant in iMessage, on calls, and in the dashboard |
| Confidence in the next move | Options with trade-offs across accounts, a pick with a reason, approval before anything happens |
| Something no one has thought of | PacePay negotiates the due date on a real call and checks each offer live |

## NVIDIA: Use Nemotron Beyond a Chatbot

| NVIDIA requires | How PacePay does it |
|---|---|
| Use Nemotron | Ultra plans and plays the lenders, Super runs the plan and decides every call response, Nano 2 VL reads bills. Every Activity step is labeled with its model. |
| Beyond a chatbot | It acts on events, not prompts: a bill photo with no question, a daily check that catches the maturing CD. It places real phone calls. |
| Multi-step workflows | For the repair: shortfall → options → pick → loan terms → call plan → limits OK → second opinion → call → judge each offer → mid-call approval → confirm → update forecast → reminder |
| Tool integration | Photon, LiveKit and GPT realtime, the forecast engine, a TrueFoundry gateway, Claude, a scheduler |
| Real-world applicability | Overdrafts and late fees are common, and lenders do move due dates |

Winning patterns covered: multi-agent (planner, orchestrator, negotiator, bill reader, lender simulator, reviewer), agentic RAG (the planner decides whether it needs a loan's fine print), ReAct (the negotiator calls `check_offer` and picks its reply from the result), multimodal (bill photos), and simulation and eval (the Arena).

## Photon: Build a messaging agent on Photon 2.0

| Photon rewards | How PacePay does it |
|---|---|
| Live on a Photon channel | An iMessage line for texts and an SMS number for calls, saved on one contact card |
| Best Voice Agent | PacePay calls the lender over LiveKit on the Photon number, [check: call-in with PIN status] |
| Human-in-the-loop | Yoshua picks the option, OKs the limits before the call, and approves the deal mid-call by text |
| Context across time and channels | The call summary lands in the thread, and PacePay remembers rules and past decisions |
| A delightful default | Quiet unless the forecast crosses a floor; one-word replies; a chart instead of a wall of text |
| Safety and fallbacks | AI disclosure on every call, offers read back, a 60-second approval timeout, a reference number if the lender needs identity checks |

## Arena results

We ran 50 simulated lenders (cooperative, fee-pushing, stubborn on dates, vague, flat refusal, identity check, chatty). Nemotron 3 Ultra played each lender, PacePay's negotiator answered, and Claude graded every transcript.

| Result | Value |
|---|---|
| Runs | 50 |
| Deals reached | 70% |
| Limit violations | 0 |
| Balance or limit disclosures | 0 |
| Offers read back | 98% |

Flat refusals and identity checks end without a deal by design. Every transcript is in `docs/arena-transcripts.md`. **A rerun is pending after negotiator fixes.** [check: update numbers after the rerun]

## Bill reader accuracy

30 bill photos with known amounts and due dates, drawn by code and generated by AI: **30/30 amounts read correctly.** [check: due-date accuracy, and the split between code-drawn and AI-generated]

## Challenges

- **No model does math.** Every number comes from the engine; models only read numbers in, and PacePay confirms each one.
- **Real calls are noisy.** Our first real call showed us the voice agent needed to say the ask up front, ignore line noise, and never hang up on its own.
- **Payday is risky.** A payment on Thursday might post before the deposit. The engine treats it as a failure, so Wednesday and Thursday offers both get pushed back.
- **Keeping secrets on a call.** The voice model can't leak a balance it never receives.
- **A $35 fee is affordable but not allowed.** PacePay pushes back without revealing the limit.

## Accomplishments

- A full loop on real phones: photo → options → limits OK → call → mid-call approval → done text
- 0 limit violations and 0 disclosures across 50 simulated lenders
- A dashboard and an agent on the same data and the same calculator
- Charts in iMessage that are exact, because they come from the engine

## What we learned

- Measure before swapping models. Nemotron held every seat it was given, except where testing showed otherwise [check: which seats moved].
- Gates in code beat instructions in prompts.
- Short texts with a pick and a reason get faster replies than a wall of options.

## What's next

- **Plaid:** connect a real bank instead of a seeded household
- **Household mode:** a partner gets the same summaries and can approve
- **Spanish:** PacePay talks to the user in Spanish while negotiating with the lender in English

## Built with

Nemotron 3 Ultra, Nemotron 3 Super, Nemotron Nano 2 VL, Claude Opus 5.5, OpenAI GPT realtime, GPT Image 2, LiveKit Agents, Photon 2.0 (iMessage, `spectrum-ts`), TrueFoundry, build.nvidia.com, TypeScript, Node, Postgres, Next.js, shadcn/ui, visx, Vercel, Langfuse [check: Langfuse and Postgres in the shipped build]
