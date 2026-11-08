/**
 * Demo mode's chart image: the mockup's small static pace-line picture (the repair week).
 * Live mode shows the real PNG from /api/media instead. Owned by: dash-tabs-a.
 */
export function MiniChart() {
  return (
    <>
      <span className="block font-semibold">Lowest: −$300 on Tue, Nov 10</span>
      <span className="mb-2 block text-chart text-muted">Checking, next 14 days</span>
      <svg
        role="img"
        aria-label="Chart image: checking drops to −$300 on Tue and Wed, then recovers on Thu payday"
        viewBox="0 0 260 98"
        className="block h-auto w-full"
      >
        <defs>
          <pattern id="pp-msg-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--hatch-bg)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--hatch)" strokeWidth="1.6" />
          </pattern>
        </defs>
        <rect x="55.71" y="76.6" width="37.15" height="11.4" fill="url(#pp-msg-hatch)" />
        <line x1="0" y1="76.6" x2="260" y2="76.6" stroke="var(--zero-line)" strokeWidth="1.5" />
        <polyline
          points="0,27.2 37.14,27.2 37.14,72.8 55.71,72.8 55.71,88 92.86,88 92.86,12 167.14,12 167.14,20.36 222.86,20.36 222.86,48.86 260,48.86"
          fill="none"
          stroke="var(--green)"
          strokeWidth="2.6"
          strokeLinejoin="round"
        />
        <circle cx="65" cy="88" r="4.5" fill="var(--vermilion)" stroke="var(--panel)" strokeWidth="2" />
      </svg>
    </>
  );
}
