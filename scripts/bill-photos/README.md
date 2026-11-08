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

## Using it

The reader test itself lives with the `read_bill` tool: it runs each image through the reader and compares merchant, total, due date and line items against `manifest.json`. Image models can misspell digits, so spot-check an image against the manifest before treating a reader miss as a reader bug.
