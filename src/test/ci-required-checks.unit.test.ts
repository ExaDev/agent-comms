import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const Job = z.looseObject({
  name: z.string().optional(),
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  steps: z
    .array(
      z.looseObject({
        run: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
});
type Jobs = Record<string, z.infer<typeof Job>>;
const Workflow = z.object({ jobs: z.record(z.string(), Job) });

const workflow = Workflow.parse(
  parse(
    readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ),
);

/** The job the ruleset's required status check should name. */
const AGGREGATE = "required-checks";

/**
 * The only conditions that make a job run on a push or a manual dispatch and never on a pull request. Any other condition on a job outside the aggregate is refused, because a condition that merely mentions the push event (`push || pull_request`, a negation, a status function) can still run on a pull request.
 */
const NEVER_ON_A_PULL_REQUEST: readonly string[] = [
  "github.event_name == 'push'",
  "github.ref == 'refs/heads/main' && github.event_name == 'push'",
  "github.event_name == 'workflow_dispatch' && inputs.registry_ref == ''",
  "!cancelled() && needs.release.result != 'failure' && ((github.ref == 'refs/heads/main' && github.event_name == 'push') || github.event_name == 'workflow_dispatch')",
];

/** The status functions that let a job run although a job it needs was skipped or failed. */
const STATUS_FUNCTION = /\b(?:always|failure|cancelled|success)\s*\(/iu;

function needsOf(jobs: Jobs, id: string): string[] {
  const needs = jobs[id]?.needs;
  if (needs === undefined) return [];
  return typeof needs === "string" ? [needs] : needs;
}

/** A job's condition with its whitespace collapsed and any `${{ }}` wrapper removed. */
function normalisedCondition(jobs: Jobs, id: string): string | undefined {
  const condition = jobs[id]?.if;
  if (condition === undefined) return undefined;
  const unwrapped = /^\$\{\{(.*)\}\}$/su.exec(condition.trim());
  return (unwrapped?.[1] ?? condition).trim().replace(/\s+/gu, " ");
}

/**
 * Whether a job never runs on a pull request, where a merge is waiting on it: its condition is one of the exact forms above, or it needs such a job and its own condition has no status function that would run it when that job is skipped.
 */
function neverOnPullRequest(
  jobs: Jobs,
  id: string,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (seen.has(id)) return false;
  const condition = normalisedCondition(jobs, id);
  if (condition !== undefined && NEVER_ON_A_PULL_REQUEST.includes(condition)) {
    return true;
  }
  if (condition !== undefined && STATUS_FUNCTION.test(condition)) return false;
  return needsOf(jobs, id).some((need) =>
    neverOnPullRequest(jobs, need, new Set([...seen, id])),
  );
}

describe("ci.yml required-checks", () => {
  const job = workflow.jobs[AGGREGATE];

  it("has the name a ruleset's required status check should use", () => {
    expect(job?.name).toBe("Required Checks");
  });

  it("needs every job that runs on a pull request, so none can be ignored by the merge", () => {
    const expected = Object.keys(workflow.jobs)
      .filter(
        (id) => id !== AGGREGATE && !neverOnPullRequest(workflow.jobs, id),
      )
      .sort();
    expect([...needsOf(workflow.jobs, AGGREGATE)].sort()).toEqual(expected);
  });

  it("needs only jobs that always run, since a skipped needed job reads as passing", () => {
    const conditioned = needsOf(workflow.jobs, AGGREGATE).filter(
      (id) => workflow.jobs[id]?.if !== undefined,
    );
    expect(conditioned).toEqual([]);
  });

  it("leaves out a job only when its condition is exactly a form that never runs on a pull request", () => {
    const needed = needsOf(workflow.jobs, AGGREGATE);
    const outside = Object.keys(workflow.jobs).filter(
      (id) => id !== AGGREGATE && !needed.includes(id),
    );
    for (const id of outside) {
      expect(
        neverOnPullRequest(workflow.jobs, id),
        `${id} is outside the aggregate`,
      ).toBe(true);
    }
  });

  describe("the classification", () => {
    const parsed = (jobs: Record<string, unknown>): Jobs =>
      Workflow.parse({ jobs }).jobs;

    it("accepts the exact conditions", () => {
      expect(
        neverOnPullRequest(
          parsed({ a: { if: "github.event_name == 'push'" } }),
          "a",
        ),
      ).toBe(true);
      expect(
        neverOnPullRequest(
          parsed({
            a: {
              if: "${{ github.ref == 'refs/heads/main' &&   github.event_name == 'push' }}",
            },
          }),
          "a",
        ),
      ).toBe(true);
    });

    it("refuses a condition that can run on a pull request", () => {
      for (const condition of [
        "github.event_name == 'push' || github.event_name == 'pull_request'",
        "always() && github.event_name == 'push'",
        "Always() && github.event_name == 'push'",
        "!(github.event_name == 'push')",
        "github.event_name != 'pull_request'",
        "contains(github.event_name, 'push')",
      ]) {
        expect(
          neverOnPullRequest(parsed({ a: { if: condition } }), "a"),
          condition,
        ).toBe(false);
      }
    });

    it("follows a need on such a job unless the condition runs despite it", () => {
      const release = { if: "github.event_name == 'push'" };
      expect(
        neverOnPullRequest(parsed({ release, a: { needs: ["release"] } }), "a"),
      ).toBe(true);
      expect(
        neverOnPullRequest(
          parsed({ release, a: { needs: ["release"], if: "Always()" } }),
          "a",
        ),
      ).toBe(false);
    });
  });

  it("runs even when a needed job fails, since a skipped aggregate reads as passing", () => {
    expect(job?.if).toBe("always()");
  });

  describe("its verdict", () => {
    const step = job?.steps?.[0];
    const script = step?.run ?? "";

    function verdict(results: string): number | null {
      return spawnSync("bash", ["-c", script], {
        env: { PATH: process.env.PATH ?? "", RESULTS: results },
      }).status;
    }

    it("has a script to run", () => {
      expect(script).not.toBe("");
    });

    it("passes on success and on a job skipped on purpose", () => {
      expect(verdict("success success skipped success")).toBe(0);
    });

    it("fails on a failed, cancelled or unrecognised result", () => {
      for (const bad of ["failure", "cancelled", "timed_out", "neutral"]) {
        expect(verdict(`success ${bad}`), bad).toBe(1);
      }
    });

    it("reads the results from the needs context", () => {
      expect(step?.env?.RESULTS).toBe("${{ join(needs.*.result, ' ') }}");
    });
  });
});
