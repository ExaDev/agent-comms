import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * The titles of the tests in a TypeScript test file, read from its syntax and not from running it, each as the names of its enclosing `describe` blocks and the test's own, joined by ` > `. A call counts when its callee is `describe`, `it` or `test` (with `.skip`, `.only`, `.todo` or `.skipIf(...)` after it, or an `.each(...)` table whose title is kept as its template), and its first argument is a string literal.
 */

const BLOCKS: ReadonlySet<string> = new Set(["describe", "it", "test"]);

/** The name a callee ends at, for `it`, `it.skip` and `it.each(table)`, and whether it opens a `describe` block. */
function calleeName(
  expression: ts.Expression,
): { name: string; each: boolean } | undefined {
  if (ts.isIdentifier(expression)) {
    return { name: expression.text, each: false };
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const inner = calleeName(expression.expression);

    return inner === undefined ? undefined : { ...inner };
  }
  if (ts.isCallExpression(expression)) {
    const inner = calleeName(expression.expression);

    return inner === undefined ? undefined : { ...inner, each: true };
  }

  return undefined;
}

export function testTitles(path: string): readonly string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const titles: string[] = [];
  const visit = (node: ts.Node, enclosing: readonly string[]): void => {
    let next = enclosing;
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      const first = node.arguments[0];
      if (
        callee !== undefined &&
        BLOCKS.has(callee.name) &&
        first !== undefined &&
        ts.isStringLiteralLike(first)
      ) {
        const title = [...enclosing, first.text].join(" > ");
        if (callee.name === "describe") {
          next = [...enclosing, first.text];
        } else {
          titles.push(title);
        }
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, next);
    });
  };
  visit(source, []);

  return titles;
}
