import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR_ENV_VAR, resolveDataDir } from "../core/data-directory.js";

describe("resolveDataDir", () => {
  it.each([undefined, "", "  "])(
    "keeps the home-directory default for %j",
    (value) => {
      expect(resolveDataDir({ env: { [DATA_DIR_ENV_VAR]: value } })).toBe(
        path.join(os.homedir(), ".agent-comms"),
      );
    },
  );

  it("uses the environment directory, trimming surrounding whitespace", () => {
    const dir = path.join(os.tmpdir(), "private mesh");
    expect(resolveDataDir({ env: { [DATA_DIR_ENV_VAR]: ` ${dir} ` } })).toBe(
      dir,
    );
  });

  it("keeps an explicit directory unchanged and ahead of the environment", () => {
    const dir = path.join(os.tmpdir(), "folder with trailing space ");
    expect(
      resolveDataDir({ dir, env: { [DATA_DIR_ENV_VAR]: "another folder" } }),
    ).toBe(dir);
  });

  it.each(["data", "./data", "../data", "~/x", " ~/x "])(
    "rejects a non-absolute environment directory %j",
    (value) => {
      expect(() =>
        resolveDataDir({ env: { [DATA_DIR_ENV_VAR]: value } }),
      ).toThrow(`${DATA_DIR_ENV_VAR} or explicit dir must be an absolute path`);
    },
  );

  it.each(["", " ", "data", "./data", "../data", "~/x"])(
    "rejects a non-absolute explicit directory %j without falling back",
    (dir) => {
      expect(() =>
        resolveDataDir({
          dir,
          env: { [DATA_DIR_ENV_VAR]: path.join(os.tmpdir(), "valid mesh") },
        }),
      ).toThrow(`${DATA_DIR_ENV_VAR} or explicit dir must be an absolute path`);
    },
  );
});
