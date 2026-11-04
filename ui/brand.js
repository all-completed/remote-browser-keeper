// The Keeper's brand for the ui-components AppShell: its name, its app icon and its
// service colour. The colour is the shell's accent AND rsuite's primary palette (buttons,
// toggles, focus rings, links), so it is the app's accent colour everywhere.
//
// Both come from the icons registry (icons.f-proj.com, vasyaod/icons#11): the flat
// browser-window-and-key app icon (src/assets/icon.png, a copy of build/icon.png from the
// registry's desktop/remote-browser-keeper/) and the service colour, emerald #2BA673.
import icon from "../src/assets/icon.png";

//
// No `sub` label (issue #31): "Remote Browser Keeper KEEPER" does not fit the 260px sidebar on
// one line, so the label wrapped onto a second line and made the brand block 90px tall
// against the title bar's 56px. The name already says "Keeper".
export const BRAND = {
  name: "Remote Browser Keeper",
  icon,
  color: "#2BA673",
};
