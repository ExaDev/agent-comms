/**
 * An identity file that cannot be used is reported once per reporter: the cc-peer front meets the same file on every tick, and a second line says nothing the first did not.
 */
import { expect, it } from "vitest";
import { createMeshErrorReporter } from "../core/error-reporting.js";
import { UnusableIdentityRecordError } from "../core/issuer-identity-file.js";

it("writes the refusal once however often it is met, and once for each file", () => {
  const lines: string[] = [];
  const report = createMeshErrorReporter((line) => {
    lines.push(line);
  });
  const first = new UnusableIdentityRecordError(
    "/data/a.json",
    "not valid JSON",
  );

  report(first);
  report(first);
  report(new UnusableIdentityRecordError("/data/b.json", "not valid JSON"));

  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("/data/a.json");
  expect(lines[1]).toContain("/data/b.json");
});
