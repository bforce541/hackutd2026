'use client';
/**
 * Call: live transcript (last 4 lines), offers checked with one-word verdicts, Next line / Ask
 * Yoshua (demo), End call, and the text fallback ("Negotiating by text" with the lender console).
 * Owned by: dash-panel.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { formatTimer, type OfferVerdict, type Speaker } from '@pacepay/shared';
import type { DashboardProps, OfferRow } from '@/lib/view-model';
import { cn } from '@/lib/cn';
import {
  ButtonRow,
  CHECK_PATH,
  CONTROL_BORDER,
  CROSS_PATH,
  INPUT_FILL,
  MarkIcon,
  Note,
  PrimaryButton,
  SecondaryButton,
  TextButton,
} from './primitives';

/** Works is green, Overdrawn is vermilion, every limits failure is ochre (UI.md color roles). */
function verdictColor(v: OfferVerdict): string {
  if (v === 'Works') return 'var(--green)';
  if (v === 'Overdrawn') return 'var(--vermilion)';
  return 'var(--ochre)';
}

function OfferItem({ offer }: { offer: OfferRow }) {
  const color = verdictColor(offer.verdict);
  return (
    <li className="flex items-center gap-[0.625em] border-t border-hairline py-[0.5em]">
      <MarkIcon path={offer.pass ? CHECK_PATH : CROSS_PATH} color={color} />
      <span className="min-w-0 flex-auto text-[0.9375em]">{offer.label}</span>
      <span className="flex-none text-[0.9375em] font-semibold" style={{ color }}>
        {offer.verdict}
      </span>
    </li>
  );
}

/** The lender console: in text mode the lender's side is typed here and posted to the negotiator. */
function LenderBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div
      className={cn(
        'mt-[1em] rounded-lg border px-[0.75em] py-[0.5em] focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-green',
        CONTROL_BORDER,
        INPUT_FILL,
      )}
    >
      <label htmlFor="pp-lender" className="block text-[0.8125em] text-muted">
        Lender types here
      </label>
      <input
        id="pp-lender"
        type="text"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block min-h-[1.45em] w-full border-0 bg-transparent p-0 text-[1em] text-ink outline-none"
      />
    </div>
  );
}

export function CallStep({ state, actions }: DashboardProps) {
  const c = state.call;
  const live = state.mode === 'live';
  const textMode = c?.textMode ?? false;
  const [draft, setDraft] = useState('');

  const speakerName = (s: Speaker) =>
    s === 'pacepay' ? 'PacePay' : s === 'counterparty' ? 'Lender' : state.household.personName;

  const lines = c?.transcriptTail ?? [];
  const offers = c?.offers ?? [];
  const lenderNext = c?.lenderNext ?? null;
  const atEnd = !live && (c?.atEnd ?? false);

  // Demo text mode: the console is prefilled with the lender's next scripted line (as the mockup).
  useEffect(() => {
    if (!live) setDraft(lenderNext ?? '');
  }, [live, lenderNext]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (live) {
      if (textMode && text) {
        actions.lenderSays(text); // POST /api/negotiations/:id/lender
        setDraft('');
      }
    } else if (textMode && text && text !== lenderNext) {
      actions.lenderSays(text); // demo: the typed line, checked by the engine
    } else {
      actions.nextLine(); // demo: the next scripted line, or "Ask Yoshua" at the end
    }
  };

  let primary: { label: string; disabled?: boolean } | null;
  if (live) primary = textMode ? { label: 'Send as lender', disabled: !draft.trim() } : null;
  else if (atEnd) primary = { label: 'Ask Yoshua' };
  else primary = { label: textMode && lenderNext ? 'Send as lender' : 'Next line' };

  return (
    <form className="flex flex-col" onSubmit={onSubmit}>
      <div className="flex items-center gap-[0.5em]">
        <span
          aria-hidden="true"
          className={cn('size-2 flex-none rounded-full', textMode ? 'bg-ochre-line' : 'bg-green')}
        />
        <p className="m-0 font-semibold">{textMode ? 'Negotiating by text' : 'On the call with your lender'}</p>
        <span className="ml-auto text-label text-muted">
          {formatTimer(c?.elapsedSec ?? 0)}
        </span>
      </div>
      {textMode && <Note className="mt-[0.25em]">The call dropped. Same negotiator, same limits.</Note>}

      <ol aria-label="Transcript" aria-live="polite" className="m-0 mt-[1em] flex list-none flex-col gap-[0.75em] p-0">
        {lines.map((l, i) => (
          <li key={`${l.at}-${i}`}>
            <span className={cn('block text-[0.8125em] font-semibold', l.speaker === 'pacepay' ? 'text-green' : 'text-muted')}>
              {speakerName(l.speaker)}
            </span>
            <span className="block text-[0.9375em] leading-[1.4]">{l.text}</span>
          </li>
        ))}
      </ol>
      {lines.length === 0 && <Note className="mt-[1em]">Calling now.</Note>}

      {offers.length > 0 && (
        <div className="mt-[1.25em]">
          <Note className="mb-[0.25em]">Offers checked</Note>
          <ul aria-label="Offers checked" className="m-0 list-none p-0">
            {offers.map((o) => (
              <OfferItem key={o.offerId} offer={o} />
            ))}
          </ul>
        </div>
      )}

      {textMode && <LenderBox value={draft} onChange={setDraft} />}

      <ButtonRow>
        {primary && (
          <PrimaryButton type="submit" className="flex-auto px-[1em]" disabled={primary.disabled}>
            {primary.label}
          </PrimaryButton>
        )}
        <SecondaryButton className={cn('px-[1.25em]', primary ? 'flex-none' : 'flex-auto')} onClick={actions.endCall}>
          {textMode ? 'Stop' : 'End call'}
        </SecondaryButton>
      </ButtonRow>
      {!textMode && (
        <TextButton
          className="mt-[0.25em] self-start p-0 underline underline-offset-[0.2em]"
          onClick={actions.failCall}
        >
          Call dropped? Switch to text
        </TextButton>
      )}
    </form>
  );
}
