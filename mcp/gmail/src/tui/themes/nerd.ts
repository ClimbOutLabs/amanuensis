import type { Theme } from "./index.js";

// Nerd-font theme — assumes a Nerd Font is installed on the terminal.
// Falls back to the default theme's colour palette but switches glyphs to
// Powerline / Nerd Font codepoints. The theme picker labels this as
// "(requires Nerd Font)" so users know to opt in.
export const nerdTheme: Theme = {
  name: "nerd",
  nerd: true,
  fg: "#e0e0e0",
  bg: "#1c1c1c",
  dim: "#7f7f7f",
  accent: "#00d7ff",
  error: "#ff5f5f",
  warning: "#ffaf5f",
  success: "#5fd75f",
  selectedFg: "#1c1c1c",
  selectedBg: "#00d7ff",
  sidebarBg: "#1c1c1c",
  modalBg: "#262626",
  statusBarBg: "#262626",
  statusBarFg: "#e0e0e0",
  helpBarFg: "#7f7f7f",
  border: "#3a3a3a",
  glyphs: {
    mail: "", // nf-mdi-email
    attachment: "", // nf-fa-paperclip
    star: "", // nf-fa-star_o
    starOn: "", // nf-fa-star (filled)
    unread: "●", // bullet
    chevronRight: "",
    chevronDown: "",
  },
};
