// The Keeper's brand for the ui-components AppShell: its name, its app icon and its
// service colour. The colour is the shell's accent AND rsuite's primary palette (buttons,
// toggles, focus rings, links), so it is the app's accent colour everywhere.
//
// PENDING vasyaod/icons#11 — the flat app icon and service colour from the icons registry
// (icons.f-proj.com). Until it lands, this is the current app icon (build/icon.svg, whose
// background is #1D4EA6) and that same blue, so the window already wears one consistent
// brand; swapping in the registry's icon + colour is this file plus src/assets/icon.png
// and the three build/icon.* files.
import icon from "../src/assets/icon.png";

export const BRAND = {
  name: "Remote Browser Keeper",
  sub: "keeper",
  icon,
  color: "#1D4EA6",
};
