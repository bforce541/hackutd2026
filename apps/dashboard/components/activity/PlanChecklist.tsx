import type { PlanStep, PlanStepStatus } from '@pacepay/shared';
import { ACTOR_LABELS, stepActor } from '@pacepay/shared';
import type { CaseView } from '@/lib/view-model';
import { cn } from '@/lib/cn';

const STATUS_TEXT: Partial<Record<PlanStepStatus, string>> = {
  running: 'In progress',
  skipped: 'Skipped',
  failed: 'Failed',
  blocked: 'Blocked',
};

/** Filled check = done, dot in a ring = in progress, empty ring = waiting. */
function Mark({ status }: { status: PlanStepStatus }) {
  const done = status === 'done';
  const running = status === 'running';
  const bad = status === 'failed';
  const stroke = done || running ? 'var(--green)' : bad ? 'var(--vermilion)' : 'var(--before-line)';
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="mt-[0.1em] flex-none">
      <circle cx="10" cy="10" r="8.25" fill={done ? 'var(--green)' : 'var(--panel)'} stroke={stroke} strokeWidth="1.5" />
      {done ? (
        <path d="M6 10.5 L8.8 13.2 L14 7.2" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {running ? <circle cx="10" cy="10" r="3" fill="var(--green)" /> : null}
      {status === 'skipped' ? <path d="M6.5 10 H13.5" stroke="var(--before-line)" strokeWidth="1.8" strokeLinecap="round" /> : null}
    </svg>
  );
}

function Row({ step }: { step: PlanStep }) {
  const waiting = step.status === 'pending' || step.status === 'blocked';
  const status = STATUS_TEXT[step.status];
  return (
    <li className="flex items-start gap-3 border-t border-hairline py-2">
      <Mark status={step.status} />
      <span className="min-w-0 flex-1">
        <span className={cn('block', waiting ? 'text-muted' : 'text-ink', step.status === 'running' && 'font-semibold')}>
          {step.title}
        </span>
        <span className="block text-chart text-muted">{ACTOR_LABELS[stepActor(step)]}</span>
        {step.note ? <span className="block text-chart text-muted">{step.note}</span> : null}
      </span>
      {status ? (
        <span className={cn('flex-none text-chart font-semibold', step.status === 'running' ? 'text-green' : step.status === 'failed' ? 'text-vermilion' : 'text-muted')}>
          {status}
        </span>
      ) : null}
    </li>
  );
}

export function PlanChecklist({ current }: { current: CaseView | null }) {
  const plan = current?.plan ?? null;
  let byline = 'Nothing in progress';
  if (plan) {
    const writer = plan.author === 'template' ? 'a template' : ACTOR_LABELS[plan.writtenBy ?? plan.author];
    byline = `${plan.goal} · plan written by ${writer}`;
  }
  return (
    <section aria-labelledby="plan-h" className="min-w-0 flex-[1_1_320px]">
      <h2 id="plan-h" className="m-0 text-[1.25rem] font-semibold">
        Plan
      </h2>
      <p className="mb-3 mt-1 text-label text-muted">{byline}</p>
      {plan ? (
        <ol className="m-0 list-none border-b border-hairline p-0">
          {plan.steps.map((s) => (
            <Row key={s.id} step={s} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}
