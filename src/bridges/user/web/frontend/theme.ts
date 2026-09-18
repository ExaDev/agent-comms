/**
 * Mantine theme carrying agent-comms' existing dark navy brand identity.
 *
 * `accent` and `dark` are 10-shade ramps anchored to the app's original CSS custom properties (--accent, --bg, --surface, --border, --text, --dim), so the chrome keeps its current look under Mantine's own components instead of Mantine's default palette. Status semantics (active/idle/busy/offline) use Mantine's built-in green/yellow/red rather than forcing the old --green/--red/--yellow constants into new theme keys.
 */

import { createTheme, type MantineColorsTuple } from "@mantine/core";

const accent: MantineColorsTuple = [
  "#e5fbff",
  "#bdf4ff",
  "#85ebff",
  "#47e0ff",
  "#0fd7ff",
  "#00b3d6",
  "#009dbd",
  "#00849e",
  "#006f85",
  "#005566",
];

const dark: MantineColorsTuple = [
  "#e4e4e4",
  "#b6b6b6",
  "#888888",
  "#4c5e74",
  "#0f3460",
  "#132b4f",
  "#16213e",
  "#1a1a2e",
  "#131321",
  "#0c0c16",
];

export const theme = createTheme({
  primaryColor: "accent",
  primaryShade: 5,
  colors: { accent, dark },
});
