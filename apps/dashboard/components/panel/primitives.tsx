/**
 * Shared pieces of the PacePay panel, ported from design/mockup/Main.dc.html. Sizes are in em so
 * they track the panel's base size (and presenter mode) exactly like the mockup. Owned by: dash-panel.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { PanelView } from '@/lib/view-model';

export type StepOf<S extends PanelView['step']> = Extract<PanelView, { step: S }>;

/*
 * Three neutrals the mockup uses that globals.css has no token for yet (requested from dash-shell):
 * control borders #CFCCC4, the secondary-button hover #F4F3EF and the lender box fill #FBFAF8.
 */
export const CONTROL_BORDER = 'border-[#cfccc4]';
const SECONDARY_HOVER = 'hover:bg-[#f4f3ef]';
export const INPUT_FILL = 'bg-[#fbfaf8]';

const FOCUS = 'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-green';

/** The small colored line above a headline: "Heads up", "Your limits", "Best fix". */
export function Eyebrow({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn('m-0 text-label font-semibold', className)}>{children}</p>;
}

/** 26px headline (Heads up, What-if, CD alert). */
export function Headline({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('m-0 mt-[0.25em] text-headline leading-[1.2] font-semibold tracking-[-0.01em]', className)}>
      {children}
    </p>
  );
}

/** 22px headline (Limits, Approve, Done). */
export function Title({ children }: { children: ReactNode }) {
  return <p className="m-0 mt-[0.25em] text-[1.375em] leading-[1.25] font-semibold">{children}</p>;
}

/** 18px option title (Best fix, Best use). */
export function OptionTitle({ children }: { children: ReactNode }) {
  return <p className="m-0 mt-[0.25em] text-[1.125em] leading-[1.3] font-semibold">{children}</p>;
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('m-0 text-muted', className)}>{children}</p>;
}

/** Small muted line: section labels ("Other options") and footers. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('m-0 text-label text-muted', className)}>{children}</p>;
}

export function Divider({ className }: { className?: string }) {
  return <div className={cn('border-t border-hairline', className)} />;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function PrimaryButton({ className, type = 'button', ...rest }: BtnProps) {
  return (
    <button
      type={type}
      className={cn(
        'min-h-12 cursor-pointer rounded-lg border-0 bg-green text-[1em] font-semibold text-white hover:brightness-[0.88] disabled:cursor-default disabled:opacity-60 disabled:hover:brightness-100',
        FOCUS,
        className,
      )}
      {...rest}
    />
  );
}

export function SecondaryButton({ className, type = 'button', ...rest }: BtnProps) {
  return (
    <button
      type={type}
      className={cn(
        'min-h-12 cursor-pointer rounded-lg border bg-panel text-[1em] font-semibold text-ink',
        CONTROL_BORDER,
        SECONDARY_HOVER,
        FOCUS,
        className,
      )}
      {...rest}
    />
  );
}

/** Plain text button (Close, "Call dropped? Switch to text"). */
export function TextButton({ className, type = 'button', ...rest }: BtnProps) {
  return (
    <button
      type={type}
      className={cn('min-h-11 cursor-pointer border-0 bg-transparent text-label text-muted', FOCUS, className)}
      {...rest}
    />
  );
}

export function ButtonRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-[1.25em] flex gap-[0.5em]', className)}>{children}</div>;
}

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="flex-none">
      <path
        d="M6 3 L11 8 L6 13"
        fill="none"
        stroke="var(--zero-line)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A clickable option row: title, muted detail, chevron. Top hairline only, like the mockup. */
export function OptionRowButton({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex min-h-12 w-full cursor-pointer items-center gap-[0.75em] border-0 border-t border-hairline bg-transparent py-[0.625em] text-left text-[1em] text-ink',
        FOCUS,
      )}
    >
      <span className="min-w-0 flex-auto">
        <span className="block font-medium group-hover:underline">{title}</span>
        <span className="block text-[0.875em] text-muted">{detail}</span>
      </span>
      <Chevron />
    </button>
  );
}

export interface DefRow {
  label: string;
  value: ReactNode;
}

/** The hairline-ruled label/value list (Limits, Approve, Done). */
export function DefRows({ rows, valueClassName = 'font-medium' }: { rows: DefRow[]; valueClassName?: string }) {
  return (
    <dl className="m-0 mt-[1em] grid grid-cols-[auto_minmax(0,1fr)]">
      {rows.map((r, i) => {
        const last = i === rows.length - 1;
        const rule = cn('border-t border-hairline', last && 'border-b');
        return (
          <div key={`${r.label}-${i}`} className="contents">
            <dt className={cn('py-[0.625em] pr-[1em] text-muted', rule)}>{r.label}</dt>
            <dd className={cn('m-0 py-[0.625em] text-right', valueClassName, rule)}>{r.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export const CHECK_PATH = 'M4 10.5 L8.5 15 L16 5.5';
export const CROSS_PATH = 'M5 5 L15 15 M15 5 L5 15';

export function MarkIcon({ path, color, size = 16 }: { path: string; color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className="flex-none">
      <path d={path} fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
