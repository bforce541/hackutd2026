import type { CSSProperties } from 'react';
import type { PlanStep, PlanStepStatus } from '@pacepay/shared';
import { ACTOR_LABELS, stepActor } from '@pacepay/shared';
import type { CaseView } from '@/lib/view-model';
import { cn } from '@/lib/cn';

const STATUS_TEXT: Partial<Record<PlanStepStatus, string>> = {
  running: 'Running',
  skipped: 'Skipped',
  failed: 'Failed',
  blocked: 'Blocked',
};

/** A node on the timeline. Done draws its check; running pulses; waiting is a hollow ring. */
function Node({ status, delay }: { status: PlanStepStatus; delay: number }) {
  const done = status === 'done';
  const running = status === 'running';
  const bad = status === 'failed';
  return (
    <span className="relative flex size-6 flex-none items-center justify-center">
      {running && (
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-leaf"
          style={{ animation: 'ring 1.6s var(--ease-out) infinite' }}
        />
      )}
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" className="relative">
        <circle
          cx="12"
          cy="12"
          r="10"
          style={{
            fill: done ? 'var(--leaf)' : running ? 'var(--panel)' : bad ? 'var(--vermilion-tint)' : 'var(--panel)',
            stroke: done || running ? 'var(--leaf)' : bad ? 'var(--coral)' : 'var(--before-line)',
          }}
          strokeWidth="1.6"
        />
        {done && (
          <path
            d="M7.5 12.4 L10.6 15.4 L16.5 9"
            fill="none"
            stroke="#fff"
            strokeWidth="2.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray={1}
            style={{ animation: `draw 520ms var(--ease-out) ${delay}ms both` }}
          />
        )}
        {running && <circle cx="12" cy="12" r="3.6" style={{ fill: 'var(--leaf)' }} />}
        {bad && <path d="M8.5 8.5 L15.5 15.5 M15.5 8.5 L8.5 15.5" stroke="var(--coral)" strokeWidth="2" strokeLinecap="round" />}
        {status === 'skipped' && <path d="M8 12 H16" stroke="var(--before-line)" strokeWidth="2" strokeLinecap="round" />}
      </svg>
    </span>
  );
}

function Row({ step, index, last, nextDone }: { step: PlanStep; index: number; last: boolean; nextDone: boolean }) {
  const waiting = step.status === 'pending' || step.status === 'blocked';
  const status = STATUS_TEXT[step.status];
  return (
    <li className="rise relative flex gap-3.5 pb-5" style={{ '--d': `${80 + index * 45}ms`, animationDuration: '520ms' } as CSSProperties}>
      {!last && (
        <span
          aria-hidden="true"
          className="absolute left-[11.25px] top-7 bottom-0 w-[1.5px] rounded-full"
          style={{ background: step.status === 'done' && nextDone ? 'var(--leaf)' : 'var(--hairline)', transition: 'background-color 600ms var(--ease-out)' }}
        />
      )}
      <Node status={step.status} delay={200 + index * 45} />
      <span className="min-w-0 flex-1 pt-px">
        <span className={cn('block leading-snug', waiting ? 'text-muted' : 'text-ink', step.status === 'running' && 'font-medium')}>{step.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="eyebrow rounded-full border border-hairline px-2 py-0.5 text-muted">{ACTOR_LABELS[stepActor(step)]}</span>
          {status && (
            <span className={cn('eyebrow', step.status === 'running' ? 'text-green' : step.status === 'failed' ? 'text-vermilion' : 'text-muted')}>
              {status}
            </span>
          )}
        </span>
        {step.note ? <span className="mt-1 block text-chart text-muted">{step.note}</span> : null}
      </span>
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
  const doneCount = plan ? plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length : 0;
  return (
    <section
      aria-labelledby="plan-h"
      className="rise min-w-0 flex-[1_1_22rem] self-start rounded-[1.75rem] border border-hairline bg-panel p-6 shadow-panel"
      style={{ '--d': '60ms' } as CSSProperties}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="plan-h" className="eyebrow m-0 text-muted">
          Plan
        </h2>
        {plan ? (
          <span className="eyebrow text-muted">
            {doneCount}/{plan.steps.length} done
          </span>
        ) : null}
      </div>
      <p className="mb-5 mt-2 text-body leading-snug">{byline}</p>
      {plan ? (
        <ol className="m-0 list-none p-0">
          {plan.steps.map((s, i) => (
            <Row key={s.id} step={s} index={i} last={i === plan.steps.length - 1} nextDone={plan.steps[i + 1]?.status === 'done' || plan.steps[i + 1]?.status === 'running'} />
          ))}
        </ol>
      ) : (
        <p className="m-0 text-muted">Text PacePay a bill and its plan shows up here, step by step.</p>
      )}
    </section>
  );
}
