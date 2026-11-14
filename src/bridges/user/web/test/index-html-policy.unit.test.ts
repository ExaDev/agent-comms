/**
 * The dashboard page carries a content security policy that lets it load only its own script and talk only to itself and to a bridge on this machine, and the page itself loads nothing from another host. GitHub Pages cannot set headers, so the policy is a meta tag in the page.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INDEX_HTML = fs.readFileSync(
  fileURLToPath(new URL("../frontend/index.html", import.meta.url)),
  "utf-8",
);

/** The sources a connection may name besides the page's own origin: a bridge on this machine, over http or its socket, on any port. */
const LOOPBACK_SOURCE = /^(ws|http):\/\/(127\.0\.0\.1|localhost):\*$/u;

function policyOf(html: string): Map<string, string[]> {
  const metas = [
    ...html.matchAll(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/giu,
    ),
  ];
  if (metas.length !== 1) {
    throw new Error(
      `expected one policy meta tag, found ${String(metas.length)}`,
    );
  }
  const directives = new Map<string, string[]>();
  for (const part of (metas[0]?.[1] ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/u);
    if (name === undefined || name === "") continue;
    if (directives.has(name)) throw new Error(`directive ${name} given twice`);
    directives.set(name, sources);
  }
  return directives;
}

describe("the dashboard page's content security policy", () => {
  const policy = policyOf(INDEX_HTML);

  it("denies everything by default and allows script only from the page's own origin", () => {
    expect(policy.get("default-src")).toEqual(["'none'"]);
    expect(policy.get("script-src")).toEqual(["'self'"]);
  });

  it("lets a connection reach only the page's own origin or a bridge on this machine", () => {
    const sources = policy.get("connect-src") ?? [];

    expect(sources).toContain("'self'");
    for (const source of sources.filter((s) => s !== "'self'")) {
      expect(source, source).toMatch(LOOPBACK_SOURCE);
    }
  });

  it("allows no remote host, wildcard scheme or eval in any directive", () => {
    for (const [name, sources] of policy) {
      for (const source of sources) {
        expect(source, `${name} ${source}`).not.toMatch(
          /^https?:\/\/(?!127\.0\.0\.1|localhost)/u,
        );
        expect(source, `${name} ${source}`).not.toBe("*");
        expect(source, `${name} ${source}`).not.toBe("https:");
        expect(source, `${name} ${source}`).not.toBe("'unsafe-eval'");
        expect(source, `${name} ${source}`).not.toBe("'wasm-unsafe-eval'");
      }
    }
  });

  it("allows inline style only, since the component library sets style attributes, and data images", () => {
    const withUnsafeInline = [...policy]
      .filter(([, sources]) => sources.includes("'unsafe-inline'"))
      .map(([name]) => name);

    expect(withUnsafeInline).toEqual(["style-src"]);
    expect(policy.get("img-src")).toEqual(["'self'", "data:"]);
  });

  it("allows its own worker and manifest, and no base or form target", () => {
    expect(policy.get("worker-src")).toEqual(["'self'"]);
    expect(policy.get("manifest-src")).toEqual(["'self'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("form-action")).toEqual(["'none'"]);
  });
});

describe("the dashboard page", () => {
  it("has no inline script, which the policy would refuse", () => {
    const scripts = [...INDEX_HTML.matchAll(/<script\b([^>]*)>/giu)];

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script[1]).toMatch(/\ssrc="/u);
  });

  it("refers to its script, manifest and icons only by relative path", () => {
    const references = [
      ...INDEX_HTML.matchAll(/\s(?:src|href)="([^"]*)"/giu),
    ].map((match) => match[1] ?? "");

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(reference).toMatch(/^\.\//u);
  });

  it("rejects a policy that is missing or given twice", () => {
    expect(() => policyOf("<html></html>")).toThrow(/found 0/u);
    const meta =
      /<meta http-equiv="Content-Security-Policy"[^>]*>/u.exec(
        INDEX_HTML,
      )?.[0] ?? "";
    expect(() => policyOf(`${meta}${meta}`)).toThrow(/found 2/u);
  });
});
