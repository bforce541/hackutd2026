# Mockup source

The source of the [PacePay UI mockup](https://claude.ai/artifact/4AYWnV8XcT1oXqxo9tNyjG), copied here so the dashboard port can read it.

- `Main.dc.html`: the clickable dashboard. The markup is HTML with `{{ holes }}`, `<sc-if>` and `<sc-for>`; the logic is the `Component` class at the bottom (`renderVals()`), including the forecast math, the chart label placement and every panel state.
- `Phone.dc.html`, `Phone2.dc.html`, `Phone3.dc.html`: the iMessage thread in three screens.

`UI.md` is the source of truth for the design. If this copy and the artifact differ, the artifact is newer.
