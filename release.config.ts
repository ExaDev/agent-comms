import type { GlobalConfig } from "semantic-release";

const config: GlobalConfig = {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "refactor", release: "patch" },
          { type: "perf", release: "patch" },
          { type: "docs", release: "patch" },
          { type: "style", release: "patch" },
          { type: "test", release: "patch" },
          { type: "build", release: "patch" },
          { type: "ci", release: "patch" },
          { type: "chore", release: "patch" },
          { breaking: true, release: "major" },
        ],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        presetConfig: {
          types: [
            { type: "feat", section: "Features" },
            { type: "fix", section: "Bug Fixes" },
            { type: "refactor", section: "Refactoring" },
            { type: "perf", section: "Performance" },
            { type: "docs", section: "Documentation" },
            { type: "style", section: "Styles" },
            { type: "test", section: "Tests" },
            { type: "build", section: "Build" },
            { type: "ci", section: "CI" },
            { type: "chore", section: "Chores" },
          ],
        },
      },
    ],
    "@semantic-release/npm",
    [
      "@semantic-release/exec",
      {
        prepareCmd:
          "node -e \"const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));const p=JSON.parse(fs.readFileSync('.claude-plugin/plugin.json','utf8'));p.version=pkg.version;fs.writeFileSync('.claude-plugin/plugin.json',JSON.stringify(p,null,2)+'\\n')\"",
      },
    ],
    [
      "@semantic-release/git",
      {
        assets: [
          "package.json",
          "pnpm-lock.yaml",
          ".claude-plugin/plugin.json",
        ],
        message: "chore(release): v${nextRelease.version} [skip ci]",
      },
    ],
    "@semantic-release/github",
  ],
};

export default config;
