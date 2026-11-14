/**
 * The shapes of the corpus cases the TypeScript runner executes. `conformance/case.schema.json` is the definition; these types state what a document that passed it holds, so a value is trusted only after the schema has accepted it.
 */

/** The case kinds the schema defines, and so the names of the corpus directories. */
export const KINDS = ["function", "validate"] as const;

/** The values of `skip`: the implementation that skips a case, never the host it runs on. */
export const SKIP_VALUES = ["ts", "rust"] as const;

/** Any JSON value, in which a string may also be written as `{ "codeUnits": [...] }`. */
export type CorpusValue =
  | null
  | boolean
  | number
  | string
  | readonly CorpusValue[]
  | { readonly [key: string]: CorpusValue };

/** A string as UTF-16 code units: a JSON string, or the code units themselves for content a JSON string cannot carry. */
export type Text = string | { readonly codeUnits: readonly number[] };

interface CaseBase {
  readonly id: string;
  readonly from: string;
  readonly skip?: (typeof SKIP_VALUES)[number];
  readonly reason?: string;
}

export interface FunctionCase extends CaseBase {
  readonly kind: "function";
  readonly function: string;
  readonly args: readonly CorpusValue[];
  readonly expect?: CorpusValue;
  readonly expectSubset?: CorpusValue;
  readonly expectUndefined?: true;
  readonly throws?: {
    readonly code?: string;
    readonly message?: readonly Text[];
  };
}

export interface ValidateIssue {
  readonly path: readonly (string | number)[];
  readonly code?: string;
  readonly message?: readonly Text[];
}

export interface ValidateCase extends CaseBase {
  readonly kind: "validate";
  readonly schema: string;
  readonly input: CorpusValue;
  readonly expect:
    | { readonly ok: true; readonly value?: CorpusValue }
    | { readonly ok: false; readonly issues: readonly ValidateIssue[] };
}

export type CorpusCase = FunctionCase | ValidateCase;

export interface CorpusFile {
  readonly cases: readonly CorpusCase[];
}

export interface Manifest {
  readonly files: Readonly<
    Record<string, { readonly cases: number; readonly skip: readonly string[] }>
  >;
}
