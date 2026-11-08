# Test bill photos

30 synthetic bill photos with known values, used to measure PacePay's bill reader (SPEC §13, v2 "Test bill photos").

- `manifest.json` is the ground truth: per bill the id, merchant, `totalCents`, `dueDate` (ISO, or `null` with a `dueNote` such as "due at pickup"), 2 to 5 `lineItems` that sum exactly to the total, and a `photoStyle` (flat scan, phone photo at an angle, crumpled, low light, thermal receipt).
- `generate.mjs` calls the image model through the TrueFoundry gateway (`TRUEFOUNDRY_BASE_URL`, `TRUEFOUNDRY_API_KEY`, `IMAGE_MODEL`) and writes `data/bills/<id>.png`. Concurrency 4, 3 attempts per bill. `data/` is gitignored, so images are regenerated locally rather than committed.

## Rerun

From the repo root:

```
npx @dotenvx/dotenvx run --convention=nextjs -- node scripts/bill-photos/generate.mjs            # all 30
npx @dotenvx/dotenvx run --convention=nextjs -- node scripts/bill-photos/generate.mjs bill-07    # one or more ids
```

The gateway serves images at `<host>/images/generations` (the `/v1` suffix on the base URL is stripped).

## Drawn bills (no model, no keys)

`render.mjs` draws the same 30 bills from `manifest.json` as SVG and renders them to PNG with `@resvg/resvg-js` (already under `apps/server`). Each one has the merchant header, the line items, the total and the due line, using exactly the manifest's numbers. It refuses to draw a bill whose line items do not sum to its total.

Per `photoStyle`: flat scan is straight-on on white with light grain. Phone photo is rotated and skewed on a wood-tone table with a soft edge shadow and grain. Crumpled has displaced paper and fold lines. Low light is dimmed with a vignette, more grain and blur. Thermal receipt is a narrow monospace strip with torn zigzag edges.

```
node scripts/bill-photos/render.mjs              # all 30 -> data/bills-code/<id>.png
node scripts/bill-photos/render.mjs bill-08      # one or more ids
```

Output goes to `data/bills-code/` (gitignored with `data/`). Use these when you need bill images fast or offline. The `data/bills/` set from `generate.mjs` is the model-made version of the same bills.

## Using it

The reader test itself lives with the `read_bill` tool: it runs each image through the reader and compares merchant, total, due date and line items against `manifest.json`. Image models can misspell digits, so spot-check an image against the manifest before treating a reader miss as a reader bug.
