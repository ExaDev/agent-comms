// Every component under test renders Mantine primitives that read theme/colour-scheme context from MantineProvider, and any component using a TanStack Query hook (agent-comms#206) needs a QueryClientProvider in its tree -- wrapping each render call the same way once here keeps every component test file from repeating the same boilerplate providers.

import type { ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { theme } from "../theme.js";

export function renderWithMantine(ui: ReactElement): RenderResult {
  // A fresh QueryClient per render call -- sharing one across tests would leak cached query results between them.
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} defaultColorScheme="dark">
        {ui}
      </MantineProvider>
    </QueryClientProvider>,
  );
}
