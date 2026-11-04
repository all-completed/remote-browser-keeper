// The Keeper's brand for the ui-components AppShell: its name, its app icon and its
// service colour. The colour is the shell's accent AND rsuite's primary palette (buttons,
// toggles, focus rings, links), so it is the app's accent colour everywhere.
//
// Both come from the icons registry (icons.f-proj.com, vasyaod/icons#11): the flat
// browser-window-and-key app icon (src/assets/icon.png, a copy of build/icon.png from the
// registry's desktop/remote-browser-keeper/) and the service colour, emerald #2BA673.
import icon from "../src/assets/icon.png";

export const BRAND = {
  name: "Remote Browser Keeper",
  sub: "keeper",
  icon,
  color: "#2BA673",
};
