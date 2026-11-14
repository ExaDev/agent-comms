import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * The titles of the tests in a TypeScript test file, read from its syntax and not from running it, each as the names of its enclosing `describe` blocks and the test's own, joined by ` > `. A call counts when its callee is `describe`, `it` or `test` (with `.skip`, `.only`, `.todo` or `.skipIf(...)` after it, or an `.each(...)` table whose title is kept as its template). Its first argument must be a string literal, since a title built at run time cannot be read from the syntax: a call whose first argument is anything else throws, naming the file and line, and the test is rewritten with a literal title or an `.each` table.
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
        !ts.isStringLiteralLike(first)
      ) {
        const line = source.getLineAndCharacterOfPosition(
          first.getStart(),
        ).line;
        throw new Error(
          `${path}:${String(line + 1)}: the title of this ${callee.name} is not a string literal, so the kept tests guard cannot read it`,
        );
      }
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

/** The files a test file imports by value, as `src`-relative paths with the `.ts` or `.tsx` extension a `.js` specifier stands for, for the relative specifiers that name a file under `root`. An `import type` and an import whose every name is a type are left out, since they carry no behaviour into the test. */
export function valueImports(
  path: string,
  root: string,
  exists: (candidate: string) => boolean,
): readonly string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".")
    ) {
      continue;
    }
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    const typeOnly =
      clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
      (clause?.name === undefined &&
        named !== undefined &&
        ts.isNamedImports(named) &&
        named.elements.every((element) => element.isTypeOnly));
    if (typeOnly) {
      continue;
    }
    const base = resolve(dirname(path), statement.moduleSpecifier.text).replace(
      /\.js$/u,
      "",
    );
    const found = [`${base}.ts`, `${base}.tsx`].find((candidate) =>
      exists(candidate),
    );
    if (found !== undefined) {
      imports.push(relative(root, found));
    }
  }

  return imports;
}
