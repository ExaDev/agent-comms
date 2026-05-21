import type { UserConfig } from "@commitlint/types";

const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "bridge",
        "cli",
        "core",
        "mesh-store",
        "tool",
        "build",
        "release",
        "ci",
        "deps",
      ],
    ],
  },
};

export default config;
