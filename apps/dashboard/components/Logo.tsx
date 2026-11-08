/**
 * PacePay's logo: "spectrum steps". Five translucent tiles step down into the dip and climb out,
 * coral (the dip) through amber (your limits) to green (recovered). Source files: design/brand/.
 */
import { cn } from '@/lib/cn';

const TILES = [
  { x: 2, y: 16, s: 20, r: 4.5, fill: '#F24E2C', o: 1 },
  { x: 11, y: 25, s: 20, r: 4.5, fill: '#FF8A3D', o: 0.9 },
  { x: 20, y: 31, s: 20, r: 4.5, fill: '#F7AC33', o: 0.9 },
  { x: 30, y: 20, s: 20, r: 4.5, fill: '#86C254', o: 0.9 },
  { x: 38, y: 6, s: 24, r: 5.5, fill: '#1F9D5C', o: 1 },
] as const;

export function LogoMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={(size * 57) / 64} viewBox="0 0 64 57" aria-hidden="true" className={className}>
      {TILES.map((t) => (
        <rect key={t.x} x={t.x} y={t.y} width={t.s} height={t.s} rx={t.r} fill={t.fill} fillOpacity={t.o} />
      ))}
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <LogoMark />
      <span className="font-brand text-[1.3125rem] font-medium leading-none tracking-[-0.03em] text-ink">pacepay</span>
      <span className="sr-only">PacePay</span>
    </span>
  );
}
