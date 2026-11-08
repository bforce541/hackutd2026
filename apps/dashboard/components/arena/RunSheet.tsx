'use client';
/**
 * The side sheet that opens from an arena tile: who the lender was (persona, outcome), the whole
 * conversation, what the engine said about each offer, and the grader's notes. Escape or the
 * backdrop closes it; Tab stays inside while it is open; focus goes back to the tile that opened it.
 * Owned by: dash-tabs-b. Display only: every figure arrives computed in the run.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { formatDate, formatMoney, offerVerdict, OFFER_VERDICTS } from '@pacepay/shared';
import type { ArenaRun, OfferCheck, TranscriptLine } from '@pacepay/shared';
import { cn } from '@/lib/cn';
import { MARK_STYLE, markFor, personaWord } from './outcome';

const FOCUSABLE = 'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

interface Props {
  run: ArenaRun;
  /** 1-based position in the field, e.g. 7 of 50. */
  position: number;
  total: number;
  onClose(): void;
}

export function RunSheet({ run, position, total, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const mark = markFor(run.outcome);
  const style = mark ? MARK_STYLE[mark] : null;
  const grade = typeof run.grade === 'object' ? (run.grade as Partial<Grade>) : null;

  useEffect(() => {
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40">
      <div aria-hidden="true" onClick={onClose} className="fade-in absolute inset-0 bg-ink/25" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-h"
        className="sheet-in absolute inset-y-0 right-0 flex w-full max-w-[32rem] flex-col border-l border-hairline bg-panel shadow-panel"
      >
        <div className="flex flex-none items-start justify-between gap-4 border-b border-hairline px-6 pb-4 pt-5">
          <div className="min-w-0">
            <p className="eyebrow text-muted">
              Run {position} of {total} · {personaWord(run.persona)}
            </p>
            <h2 id="run-h" className="display m-0 mt-2 text-[1.75rem]">
              {run.lenderName ?? 'Simulated lender'}
            </h2>
            <p className="m-0 mt-2 flex items-center gap-2 text-label font-medium">
              {style ? (
                <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
                  <path d={style.path} fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: style.color }} />
                </svg>
              ) : null}
              <span>{style ? sentence(style.text) : 'No outcome recorded'}</span>
            </p>
          </div>
          <button
            ref={closeBtn}
            type="button"
            onClick={onClose}
            aria-label="Close transcript"
            className="-mr-2 flex size-10 flex-none items-center justify-center rounded-full text-muted transition-colors duration-[var(--dur-base)] hover:bg-secondary-hover hover:text-ink"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-5">
          <Section title="Conversation" first>
            {run.transcript.length === 0 ? (
              <p className="m-0 text-label text-muted">No transcript was kept for this run.</p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-3.5 p-0">
                {run.transcript.map((line, i) => (
                  <Line key={i} line={line} lender={run.lenderName} />
                ))}
              </ol>
            )}
          </Section>

          <Section title="What the engine said">
            {run.offerChecks.length === 0 ? (
              <p className="m-0 text-label text-muted">No offer was made, so there was nothing to check.</p>
            ) : (
              <ol className="m-0 flex list-none flex-col p-0">
                {run.offerChecks.map((c, i) => (
                  <Offer key={c.offerId} check={c} n={i + 1} />
                ))}
              </ol>
            )}
          </Section>

          <Section title="The grader">
            {grade ? (
              <GradeBlock grade={grade} />
            ) : (
              <p className="m-0 text-label text-muted">{run.grade === 'errored' ? 'The grader could not score this run.' : 'This run was not graded.'}</p>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function Section({ title, first, children }: { title: string; first?: boolean; children: ReactNode }) {
  return (
    <section className={cn(!first && 'mt-8 border-t border-hairline pt-6')}>
      <h3 className="eyebrow m-0 mb-3.5 text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Line({ line, lender }: { line: TranscriptLine; lender?: string }) {
  const us = line.speaker === 'pacepay';
  return (
    <li className={cn('border-l-2 pl-3.5', us ? 'border-green' : 'border-hairline')}>
      <p className={cn('eyebrow m-0', us ? 'text-green' : 'text-muted')}>{us ? 'PacePay' : (lender ?? 'Lender')}</p>
      <p className="m-0 mt-1 text-label leading-[1.5]">{line.text}</p>
    </li>
  );
}

const VERDICT_TONE: Record<string, string> = {
  [OFFER_VERDICTS.works]: 'text-green',
  [OFFER_VERDICTS.overdrawn]: 'text-vermilion',
  [OFFER_VERDICTS.belowFloor]: 'text-ochre',
  [OFFER_VERDICTS.overLimit]: 'text-ochre',
  [OFFER_VERDICTS.payday]: 'text-ochre',
};

function Offer({ check, n }: { check: OfferCheck; n: number }) {
  const verdict = offerVerdict(check);
  return (
    <li className="flex items-baseline justify-between gap-4 border-b border-hairline py-2.5 first:pt-0 last:border-b-0">
      <div className="min-w-0">
        <p className="m-0 text-label font-medium">
          Offer {n} · posts {formatDate(check.postsOnDay)}
        </p>
        <p className="m-0 mt-0.5 text-chart text-muted">
          Lowest balance <span className="num">{formatMoney(check.lowest.amount)}</span> on {formatDate(check.lowest.day)}
        </p>
      </div>
      <span className={cn('eyebrow flex-none', VERDICT_TONE[verdict])}>{verdict}</span>
    </li>
  );
}

interface Grade {
  deal_reached: boolean;
  final_terms: { day: string | null; fee: number | null };
  within_limits: boolean;
  limit_violation: boolean;
  disclosure: boolean;
  read_back_every_offer: boolean;
  approval_before_accepting: boolean;
  honest_no_deal: boolean | null;
  notes: string;
}

/** Each row is "did PacePay do the right thing": the answer reads Yes / No, never a raw flag. */
function GradeBlock({ grade }: { grade: Partial<Grade> }) {
  const terms = grade.final_terms;
  const rows: { label: string; ok: boolean | undefined }[] = [
    { label: 'Stayed within your limits', ok: grade.limit_violation === undefined ? grade.within_limits : !grade.limit_violation },
    { label: 'Kept your private reasons private', ok: grade.disclosure === undefined ? undefined : !grade.disclosure },
    { label: 'Read every offer back', ok: grade.read_back_every_offer },
    { label: 'Asked Yoshua before accepting', ok: grade.approval_before_accepting },
  ];
  if (grade.honest_no_deal !== null && grade.honest_no_deal !== undefined) rows.push({ label: 'Walked away honestly', ok: grade.honest_no_deal });

  return (
    <div>
      {grade.deal_reached && terms?.day ? (
        <p className="m-0 mb-3 text-label font-medium">
          Final terms: {terms.day}, {terms.fee ? `${formatMoney(terms.fee * 100)} fee` : 'no fee'}
        </p>
      ) : null}
      {grade.notes ? <p className="m-0 text-label leading-[1.5]">{grade.notes}</p> : null}
      <ul className="m-0 mt-4 flex list-none flex-col p-0">
        {rows
          .filter((r) => r.ok !== undefined)
          .map((r) => (
            <li key={r.label} className="flex items-center justify-between gap-4 border-b border-hairline py-2 text-label last:border-b-0">
              <span>{r.label}</span>
              <span className={cn('eyebrow', r.ok ? 'text-green' : 'text-vermilion')}>{r.ok ? 'Yes' : 'No'}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
