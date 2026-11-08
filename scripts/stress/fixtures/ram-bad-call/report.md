# PacePay call stress report

1 conversations, **0 pass (0%)**. Harness errors: 0. 

Pass = no critical or high issue attributed to PacePay (rules + judge).

Judge: off 1. Lender played by: ? 1.

Issues: critical 4, high 4, medium 0, low 0

## Pass rate by category

| category | n | pass | rate | critical | high | avg judge score |
|---|---|---|---|---|---|---|
| fixture | 1 | 0 | 0% | 1 | 1 | - |

## Clusters by area

| area | critical | high | medium | low | conversations |
|---|---|---|---|---|---|
| negotiator | 3 | 2 | 0 | 0 | 1 |
| texts | 1 | 2 | 0 | 0 | 1 |
| voice | 0 | 0 | 0 | 0 | 0 |
| harness | 0 | 0 | 0 | 0 | 0 |

## Clusters by root cause (critical + high)

| cause | area | by | count | conversations (first 6) |
|---|---|---|---|---|
| post-approval change not handled | negotiator | rule | 2 | ram-bad-call |
| sounds like agreeing to unapproved terms | negotiator | rule | 1 | ram-bad-call |
| outcome ignores the lender's last change | texts | rule | 1 | ram-bad-call |
| Done texted mid-call | texts | rule | 1 | ram-bad-call |
| "didn't catch" on intelligible speech | negotiator | rule | 1 | ram-bad-call |
| no final text to Yoshua | texts | rule | 1 | ram-bad-call |
| closing sounds like agreement | negotiator | rule | 1 | ram-bad-call |

## All critical (4)

- **ram-bad-call** [negotiator / rule / agreed_after_change] Lender said "Uh, no, it's $35 now." (?day / $35); approved: Fri Nov 13 / $20. PacePay's reply sounds like agreement.
  - line: "That's fine. Thank you for taking care of that. Goodbye."
  ```
    LENDER : Uh, actually, I want to make that $35.
    PACEPAY: Sorry, could I get a reference number for that change?
    LENDER : Uh, no, it's $35 now.
    PACEPAY: That's fine. Thank you for taking care of that. Goodbye.
  ```
- **ram-bad-call** [negotiator / rule / ignored_change_after_approval] After approval of Fri Nov 13 / $20, lender changed to ?day / $35: "Uh, actually, I want to make that $35.". PacePay did not restate the approved terms.
  - line: "Sorry, could I get a reference number for that change?"
  ```
    PACEPAY: Thanks. One moment while I check with Yoshua.
    PACEPAY: Yoshua approved Friday, November 13 with the $20 fee. What's the reference number?
    LENDER : Uh, actually, I want to make that $35.
    PACEPAY: Sorry, could I get a reference number for that change?
  ```
- **ram-bad-call** [texts / rule / deal_on_disputed_terms] Deal committed on Fri Nov 13 / $20 but the lender last stated Fri Nov 13 / $35 ("Uh, no, it's $35 now.").
  - line: "Done. Car payment is now Fri, Nov 13 ($20)."
- **ram-bad-call** [negotiator / rule / agreeing_closing] Closing sounds like agreement while terms were disputed (lender Fri Nov 13 / $35 vs approved Fri Nov 13 / $20).
  - line: "That's fine. Thank you for taking care of that. Goodbye."
  ```
    LENDER : Uh, actually, I want to make that $35.
    PACEPAY: Sorry, could I get a reference number for that change?
    LENDER : Uh, no, it's $35 now.
    PACEPAY: That's fine. Thank you for taking care of that. Goodbye.
  ```

## All high (4)

- **ram-bad-call** [negotiator / rule / ignored_change_after_approval] After approval of Fri Nov 13 / $20, lender changed to ?day / $35: "Uh, no, it's $35 now.". PacePay did not restate the approved terms.
  - line: "That's fine. Thank you for taking care of that. Goodbye."
  ```
    LENDER : Uh, actually, I want to make that $35.
    PACEPAY: Sorry, could I get a reference number for that change?
    LENDER : Uh, no, it's $35 now.
    PACEPAY: That's fine. Thank you for taking care of that. Goodbye.
  ```
- **ram-bad-call** [texts / rule / done_text_before_call_end] Done text at 50 s; call ended at 58 s.
  - line: "Done. Car payment is now Fri, Nov 13 ($20)."
- **ram-bad-call** [negotiator / rule / false_didnt_catch] Said it didn't catch an intelligible turn: heard "Yeah, something like that.".
  - line: "Sorry, I didn't catch that."
  ```
    LENDER : Friday works, but there's gonna be a $20 fee.
    PACEPAY: Just to confirm: Friday, November 13, with a $20 fee?
    LENDER : Yeah, something like that.
    PACEPAY: Sorry, I didn't catch that.
  ```
- **ram-bad-call** [texts / rule / no_final_text] No text to Yoshua after the call ended (end=negotiator_end, outcome=deal).

## Timings

Per conversation p50 60 s, p90 60 s. decide p50 0 ms, p90 0 ms, max 0 ms.

## Per conversation

| id | pass | end | outcome | approved | lender last | judge | summary |
|---|---|---|---|---|---|---|---|
| ram-bad-call | **no** | negotiator_end | deal | Fri Nov 13 / $20 | Fri Nov 13 / $35 | - |  |
