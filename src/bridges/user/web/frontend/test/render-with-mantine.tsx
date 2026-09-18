// Every component under test renders Mantine primitives that read theme/colour-scheme context from MantineProvider -- wrapping each render call the same way once here keeps every component test file from repeating the same boilerplate provider.

import type { ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { theme } from "../theme.js";

export function renderWithMantine(ui: ReactElement): RenderResult {
  return render(
    <MantineProvider theme={theme} defaultColorScheme="dark">
      {ui}
    </MantineProvider>,
  );
}
