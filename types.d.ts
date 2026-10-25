/** JSON-safe output types. No AST nodes are persisted in the dictionary. */
export type Parameter = {
    /** Identifier used in the anonymized macro template. */
    name: string;
    /** Captured binding in surrounding code, or a normalized literal. */
    kind: "capture" | "literal";
    /** Only for literal parameters; e.g. 'number' or 'string'. */
    literalKind?: string;
};

export type Local = {
    /** Renamed declaration whose binding is inside the subtree. */
    name: string;
    /** Original spelling in the representative occurrence. */
    example: string;
};

export type Occurrence = {
    repository: string;
    file: string;
    start: number;
    end: number;
    /** Parameter expressions in precisely the order of Subtree.parameters. */
    arguments: string[];
    /** Anonymized identifier -> original spelling for this occurrence. */
    bindings: Record<string, string>;
};

export type Subtree = {
    hash: string;
    /** Human-readable or mnemonic name assigned for macro invocation. */
    name?: string;
    /** High-level classification: statement, expression, or declaration. */
    category?: "statement" | "expression" | "declaration";
    /** Exact serialized normalized tree, used to disambiguate hash collisions. */
    canonical: string;
    nodeType: string;
    size: number;
    depth: number;
    count: number;
    /** Distinct repositories containing this clone. */
    distinctRepos: number;
    /** Distinct files containing this clone. */
    distinctFiles: number;
    /** Net compression utility score. */
    score: number;
    /** Original code with binding and literal occurrences replaced by placeholders. */
    template: string;
    /** Text replacements were nonoverlapping; guarantees clean textual substitution. */
    templateReady: boolean;
    parameters: Parameter[];
    locals: Local[];
    occurrences: Occurrence[];
};

export type Dictionary = Record<string, Subtree>;

export interface DictionaryOptions {
    minOccurrences?: number;
    minRepos?: number;
    minFiles?: number;
    minNodes?: number;
    maxParameters?: number;
    keepCommonLiterals?: boolean;
    filterSubsumed?: boolean;
    allowedNodeTypes?: Set<string>;
}
