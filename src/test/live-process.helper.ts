import { spawn } from "node:child_process";

/** A child process that stays alive until `exit` is called, for tests that need a lock held by a live process other than the test's own. */
export function spawnLiveProcess(): {
  pid: number;
  exit: () => Promise<void>;
} {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 60000)"],
    { stdio: "ignore" },
  );
  if (child.pid === undefined) throw new Error("the child has no pid");
  return {
    pid: child.pid,
    exit: async () =>
      new Promise((resolve) => {
        child.on("exit", () => {
          resolve();
        });
        child.kill("SIGKILL");
      }),
  };
}

/** The pid of a process that has already exited, so a lock naming it is stale. */
export async function deadPid(): Promise<number> {
  const holder = spawnLiveProcess();
  await holder.exit();
  return holder.pid;
}
