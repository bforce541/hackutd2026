# PacePay brand

**Mark: "spectrum steps."** Five translucent tiles step down into the dip and climb out to a bigger green tile. The color is the story: coral (the dip) → amber (your limits) → green (recovered).

| File | Use |
|---|---|
| `pacepay-mark.svg` | The mark on light backgrounds (the dashboard). |
| `pacepay-mark-dark.svg` | The mark on dark backgrounds (slides, Devpost thumbnail). Brighter tiles. |
| `pacepay-logo.svg` / `pacepay-logo-dark.svg` | Mark + `pacepay` wordmark. The wordmark is live text in Instrument Sans 500, so open it where the font is installed, or use the dashboard's `components/Logo.tsx`. |
| `pacepay-avatar.svg`, `pacepay-avatar-512.png` | PacePay's avatar: the mark on near-black. Upload the PNG in Photon → Settings → Agent profile → Avatar. iMessage crops it to a circle; the mark stays inside it. |

In the dashboard: `apps/dashboard/components/Logo.tsx` (header) and `apps/dashboard/app/icon.svg` (favicon).

**Colors**

| Tile | Light background | Dark background |
|---|---|---|
| 1 (the dip starts) | `#F24E2C` | `#FF5A36` |
| 2 | `#FF8A3D` at 90% | `#FF8A3D` at 90% |
| 3 (the low) | `#F7AC33` at 90% | `#FFB547` at 90% |
| 4 | `#86C254` at 90% | `#9ED36A` at 90% |
| 5 (recovered) | `#1F9D5C` | `#2FBF71` at 95% |

Near-black for dark grounds: `#0B0B0C`. **Wordmark:** `pacepay`, lowercase, Instrument Sans 500, tracking −3%.

**Don't** recolor the tiles one flat color, put the light mark on a busy photo, or add effects. The overlaps already carry the depth.

To re-render the PNG after editing the SVG: render `pacepay-avatar.svg` at 512 px with `@resvg/resvg-js` (already in `apps/server`'s dependencies).
