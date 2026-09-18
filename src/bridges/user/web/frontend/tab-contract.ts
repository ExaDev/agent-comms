/**
 * oRPC contract the SharedWorker itself implements, serving tabs.
 *
 * A superset of meshContract (the same procedures tabs already know about, since the worker's own mutation handlers are one-line passthroughs to the real server) plus one worker-only procedure: disconnect, which a tab calls on its own pagehide to have the worker evict that tab's own MessagePort peer -- a browser MessagePort never fires a "close" event on its own, so nothing else tells the worker a tab is gone.
 */

import { z } from "zod";
import { oc } from "@orpc/contract";
import { meshContract } from "../contract.js";

export const tabContract = {
  ...meshContract,
  disconnect: oc.input(z.object({})).output(z.object({})),
};

export type TabContract = typeof tabContract;
