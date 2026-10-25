import type { Dirent } from "node:fs";

import * as acorn from "acorn";
import jsxPlugin from "acorn-jsx";
import { tsPlugin } from "@sveltejs/acorn-typescript";

import type { Dictionary, Subtree, Parameter, Local, Occurrence } from "../types.js";

const parser = acorn.Parser.extend(tsPlugin(), jsxPlugin());

type Node = acorn.Node;
type AstRecord = Node & Record<string, unknown>;
type Namespace = "value" | "type" | "both";

interface Binding {
    name: string;
    scope: Scope;
    valueSlot?: number;
    typeSlot?: number;
}

interface Scope {
    parent?: Scope;
    /** The nearest function, module, or class-static-block scope. */
    varScope: Scope;
    values: Map<string, Binding>;
    types: Map<string, Binding>;
}

interface Resolution {
    scopeOf: WeakMap<Node, Scope>;
    declarations: WeakMap<Node, Binding>;
}

function isNode(value: unknown): value is Node {
    return value !== null && typeof value === "object" &&
        typeof (value as Node).type === "string";
}

/** Walk real AST children, excluding locations and other parser metadata. */
function forEachChild(node: Node, visit: (child: Node, key: string) => void): void {
    for (const [key, value] of Object.entries(node)) {
        if (isNode(value)) {
            visit(value, key);
        } else if (Array.isArray(value)) {
            for (const child of value) {
                if (isNode(child)) visit(child, key);
            }
        }
    }
}

function createScope(parent?: Scope, varBoundary = false): Scope {
    const scope = {
        parent,
        varScope: undefined as unknown as Scope,
        values: new Map<string, Binding>(),
        types: new Map<string, Binding>(),
    };
    scope.varScope = !parent || varBoundary ? scope : parent.varScope;
    return scope;
}

function lookup(scope: Scope, name: string, namespace: "value" | "type"): Binding | undefined {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
        const binding = (namespace === "type" ? current.types : current.values).get(name);
        if (binding) return binding;
    }
    return undefined;
}

/**
 * Build a binding table before hashing anything. Declaring first and resolving
 * later handles references appearing before a declaration (including var hoisting).
 *
 * This handles common JS/TS lexical forms without needing a second parser or a
 * scope-analysis dependency. Unknown/exotic syntax is left name-sensitive.
 */
function resolveScopes(program: Node): Resolution {
    const scopeOf = new WeakMap<Node, Scope>();
    const declarations = new WeakMap<Node, Binding>();
    const rootScope = createScope();

    function declare(id: Node | null | undefined, scope: Scope, namespace: Namespace = "value"): void {
        if (!id || id.type !== "Identifier") return;
        const name = (id as acorn.Identifier).name;
        const existing = namespace === "type"
            ? scope.types.get(name)
            : scope.values.get(name);
        const binding: Binding = existing ?? { name, scope };
        if (namespace !== "type" && !scope.values.has(name)) {
            binding.valueSlot = scope.values.size;
            scope.values.set(name, binding);
        }
        if (namespace !== "value" && !scope.types.has(name)) {
            binding.typeSlot = scope.types.size;
            scope.types.set(name, binding);
        }
        declarations.set(id, binding);
    }

    function declarePattern(node: Node | null | undefined, scope: Scope): void {
        if (!node) return;
        const data = node as AstRecord;
        switch (node.type) {
            case "Identifier":
                declare(node, scope);
                return;
            case "AssignmentPattern":
                declarePattern(data.left as Node, scope);
                return;
            case "RestElement":
                declarePattern(data.argument as Node, scope);
                return;
            case "ArrayPattern":
                for (const item of (data.elements as (Node | null)[] ?? [])) {
                    declarePattern(item, scope);
                }
                return;
            case "ObjectPattern":
                for (const prop of (data.properties as Node[] ?? [])) {
                    const property = prop as AstRecord;
                    declarePattern(
                        (prop.type === "RestElement" ? property.argument : property.value) as Node,
                        scope,
                    );
                }
                return;
            case "TSParameterProperty":
                declarePattern(data.parameter as Node, scope);
                return;
        }
    }

    function visitChildren(node: Node, scope: Scope): void {
        forEachChild(node, child => visit(child, scope));
    }

    function visitFunction(node: Node, parent: Scope): void {
        const data = node as AstRecord;
        if (node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") {
            declare(data.id as Node | null, parent);
        }

        const fnScope = createScope(parent, true);
        // Named function expressions bind their names only inside the function.
        if (node.type === "FunctionExpression") {
            declare(data.id as Node | null, fnScope);
        }
        if (isNode(data.id)) visit(data.id, fnScope);

        if (isNode(data.typeParameters)) visit(data.typeParameters, fnScope);
        for (const param of (data.params as Node[] ?? [])) {
            declarePattern(param, fnScope);
        }
        for (const param of (data.params as Node[] ?? [])) visit(param, fnScope);
        if (isNode(data.returnType)) visit(data.returnType, fnScope);

        // Function bodies share their function's var scope, rather than
        // introducing another block for the parameters.
        const body = data.body;
        if (isNode(body)) {
            if (body.type === "BlockStatement") {
                scopeOf.set(body, fnScope);
                visitChildren(body, fnScope);
            } else {
                visit(body, fnScope);
            }
        }
    }

    function visit(node: Node, scope: Scope): void {
        scopeOf.set(node, scope);
        const data = node as AstRecord;

        switch (node.type) {
            case "Program":
                visitChildren(node, scope);
                return;
            case "BlockStatement":
            case "SwitchStatement": {
                const blockScope = createScope(scope);
                // The discriminant runs in the enclosing scope.
                if (node.type === "SwitchStatement" && isNode(data.discriminant)) {
                    visit(data.discriminant, scope);
                    for (const branch of (data.cases as Node[] ?? [])) visit(branch, blockScope);
                } else {
                    visitChildren(node, blockScope);
                }
                return;
            }
            case "ForStatement":
            case "ForInStatement":
            case "ForOfStatement": {
                // let/const loop bindings belong to their own lexical scope.
                const loopScope = createScope(scope);
                visitChildren(node, loopScope);
                return;
            }
            case "CatchClause": {
                const catchScope = createScope(scope);
                declarePattern(data.param as Node | null, catchScope);
                visitChildren(node, catchScope);
                return;
            }
            case "StaticBlock": {
                const staticScope = createScope(scope, true);
                visitChildren(node, staticScope);
                return;
            }
            case "VariableDeclaration": {
                const target = data.kind === "var" ? scope.varScope : scope;
                for (const decl of (data.declarations as Node[] ?? [])) {
                    declarePattern((decl as AstRecord).id as Node, target);
                }
                visitChildren(node, scope);
                return;
            }
            case "FunctionDeclaration":
            case "FunctionExpression":
            case "ArrowFunctionExpression":
            case "TSDeclareFunction":
                visitFunction(node, scope);
                return;
            case "ClassDeclaration":
            case "ClassExpression": {
                if (node.type === "ClassDeclaration") {
                    declare(data.id as Node | null, scope, "both");
                }
                const classScope = createScope(scope);
                if (node.type === "ClassExpression") {
                    declare(data.id as Node | null, classScope, "both");
                }
                if (isNode(data.id)) visit(data.id, classScope);
                if (isNode(data.typeParameters)) visit(data.typeParameters, classScope);
                if (isNode(data.superClass)) visit(data.superClass, classScope);
                if (isNode(data.superTypeParameters)) visit(data.superTypeParameters, classScope);
                if (isNode(data.implements)) visit(data.implements, classScope);
                if (Array.isArray(data.implements)) {
                    for (const impl of data.implements) if (isNode(impl)) visit(impl, classScope);
                }
                if (isNode(data.body)) visit(data.body, classScope);
                return;
            }
            case "ImportDeclaration":
                for (const spec of (data.specifiers as Node[] ?? [])) {
                    const local = (spec as AstRecord).local as Node | undefined;
                    // Imported values may also name TS types.
                    declare(local, scope, "both");
                }
                visitChildren(node, scope);
                return;
            case "TSTypeAliasDeclaration":
            case "TSInterfaceDeclaration": {
                declare(data.id as Node | null, scope, "type");
                const typeScope = createScope(scope);
                visitChildren(node, typeScope);
                return;
            }
            case "TSEnumDeclaration":
            case "TSModuleDeclaration": {
                declare(data.id as Node | null, scope, "both");
                const namespaceScope = createScope(scope);
                visitChildren(node, namespaceScope);
                return;
            }
            case "TSModuleBlock": {
                const moduleScope = createScope(scope, true);
                visitChildren(node, moduleScope);
                return;
            }
            case "TSTypeParameterDeclaration":
                for (const param of (data.params as Node[] ?? [])) {
                    const name = (param as AstRecord).name;
                    if (isNode(name)) declare(name, scope, "type");
                }
                visitChildren(node, scope);
                return;
            case "TSMappedType": {
                const mappedScope = createScope(scope);
                const parameter = data.typeParameter as AstRecord | undefined;
                if (parameter && isNode(parameter.name)) {
                    declare(parameter.name, mappedScope, "type");
                }
                visitChildren(node, mappedScope);
                return;
            }
            default:
                visitChildren(node, scope);
        }
    }

    visit(program, rootScope);
    return { scopeOf, declarations };
}

/** Identifiers in these positions are names of properties, labels, etc., not references. */
function fixedIdentifier(parent: Node | undefined, field: string | undefined): boolean {
    if (!parent) return false;
    const data = parent as AstRecord;
    if (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") {
        return field === "property" && !data.computed;
    }
    if (parent.type === "Property" || parent.type === "MethodDefinition" ||
        parent.type === "PropertyDefinition" || parent.type === "AccessorProperty" ||
        parent.type === "TSPropertySignature" || parent.type === "TSMethodSignature") {
        return field === "key" && !data.computed;
    }
    if (parent.type === "ImportSpecifier") return field === "imported";
    if (parent.type === "ExportSpecifier") return field === "exported";
    if (parent.type === "MetaProperty") return true;
    if (parent.type === "TSQualifiedName") return field === "right";
    if (parent.type === "LabeledStatement") return field === "label";
    if (parent.type === "BreakStatement" || parent.type === "ContinueStatement") {
        return field === "label";
    }
    return false;
}

/** Only structurally meaningful scalar fields are included in fingerprints. */
const SCALAR_FIELDS = new Set([
    "name", "value", "operator", "kind", "computed", "optional", "prefix",
    "async", "generator", "static", "method", "shorthand", "delegate",
    "expression", "await", "readonly", "abstract", "declare", "definite",
    "accessibility", "importKind", "exportKind", "variance", "const",
    "override", "global", "flags", "rawName", "selfClosing", "tail",
]);

function scalar(value: unknown): unknown {
    if (typeof value === "bigint") return `bigint:${value.toString()}`;
    if (value instanceof RegExp) return `regexp:${value.source}/${value.flags}`;
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return value.map(scalar);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, scalar(item)]));
    }
    return value;
}

function literalKind(value: unknown): string {
    if (value === null) return "null";
    if (value instanceof RegExp) return "regexp";
    return typeof value;
}

/** These literals cannot safely be replaced with a macro parameter identifier. */
function fixedLiteral(parent?: Node, field?: string): boolean {
    if (!parent) return false;
    const record = parent as AstRecord;
    if (field === "key" && !record.computed) return true;
    if (field === "source" && /^(Import|Export)/.test(parent.type)) return true;
    if (parent.type === "ImportAttribute") return true;
    if (parent.type === "TSLiteralType") return true;
    if (parent.type === "JSXAttribute" && field === "value") return true;
    if (parent.type === "ExpressionStatement" && record.directive) return true;
    return false;
}

function fixedName(node: Node, parent?: Node, field?: string): boolean {
    return node.type !== "Identifier" || fixedIdentifier(parent, field);
}

/**
 * Encodes named AST fields in a deterministic order. The child callback returns
 * a hash in stage 1, or a canonicalized child representation in stage 2.
 */
function encodeFields(node: Node, child: (node: Node, key: string) => unknown): unknown {
    const fields: [string, unknown][] = [];
    for (const [key, value] of Object.entries(node).sort(([a], [b]) => a.localeCompare(b))) {
        if (["type", "start", "end", "loc", "range", "raw", "extra", "parent",
             "comments", "leadingComments", "trailingComments"].includes(key)) continue;
        if (isNode(value)) {
            fields.push([key, child(value, key)]);
        } else if (Array.isArray(value)) {
            // Preserve order, holes, empty lists, and null slots.
            fields.push([key, value.map(item => isNode(item) ? child(item, key) : scalar(item))]);
        } else if (SCALAR_FIELDS.has(key)) {
            fields.push([key, scalar(value)]);
        }
    }
    return [node.type, fields];
}

interface Candidate {
    node: Node;
    resolution: Resolution;
    source: string;
    file: string;
    repository: string;
    size: number;
    depth: number;
}

/** Transient candidates used to defer expensive canonicalization. */
export type CandidateBuckets = Map<string, Candidate[]>;

const declarationsByBinding = new WeakMap<Resolution, Map<Binding, Node[]>>();

function collectDeclarationNodes(program: Node, resolution: Resolution): void {
    const byBinding = new Map<Binding, Node[]>();
    function visit(node: Node): void {
        const binding = resolution.declarations.get(node);
        if (binding) {
            const ids = byBinding.get(binding) ?? [];
            ids.push(node);
            byBinding.set(binding, ids);
        }
        forEachChild(node, visit);
    }
    visit(program);
    declarationsByBinding.set(resolution, byBinding);
}

function typePosition(parent?: Node): boolean {
    return !!parent?.type.startsWith("TS") &&
        !["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression",
          "TSTypeAssertion", "TSInstantiationExpression", "TSTypeQuery"].includes(parent.type);
}

interface Edit {
    start: number;
    end: number;
    text: string;
}

interface Normalized {
    canonical: string;
    template: string;
    parameters: Parameter[];
    locals: Local[];
    arguments: string[];
    bindings: Record<string, string>;
    templateSafe: boolean;
}

/** Normalize only likely clones; also retain enough data for macro extraction. */
function normalizeCandidate(candidate: Candidate): Normalized {
    const { node: root, source, resolution } = candidate;
    const nameByBinding = new Map<Binding, string>();
    const declarations = declarationsByBinding.get(resolution) ?? new Map<Binding, Node[]>();
    const edits: Edit[] = [];
    const parameters: Parameter[] = [];
    const locals: Local[] = [];
    const args: string[] = [];
    const bindings: Record<string, string> = {};
    let templateSafe = !/\b__clone_(?:arg|lit|local)\d+\b/.test(source.slice(root.start, root.end));
    let localCount = 0;
    let captureCount = 0;
    let literalCount = 0;

    function recordEdit(node: Node, replacement: string, parent?: Node, field?: string): void {
        let text = replacement;
        // Object shorthand {x} must become {x: __clone_arg0}, preserving key x.
        if (parent?.type === "Property" && field === "value" &&
            (parent as AstRecord).shorthand && node.type === "Identifier") {
            const key = (parent as AstRecord).key as Node;
            if (key?.type === "Identifier") text = `${(key as acorn.Identifier).name}: ${replacement}`;
            else templateSafe = false;
        }
        if ((parent?.type === "ImportSpecifier" || parent?.type === "ExportSpecifier") &&
            field === "local") {
            const property = parent as AstRecord;
            const publicId = (parent.type === "ImportSpecifier" ? property.imported : property.exported) as Node;
            if (isNode(publicId) && publicId.start === node.start && publicId.end === node.end) {
                const publicName = source.slice(node.start, node.end);
                text = parent.type === "ImportSpecifier"
                    ? `${publicName} as ${replacement}`
                    : `${replacement} as ${publicName}`;
            }
        }
        edits.push({ start: node.start, end: node.end, text });
    }

    function normalizeIdentifier(node: Node, parent?: Node, field?: string): string {
        const name = (node as acorn.Identifier).name;
        if (fixedName(node, parent, field)) return `fixed:${name}`;

        const namespace = typePosition(parent) ? "type" : "value";
        const scope = resolution.scopeOf.get(node);
        const binding = resolution.declarations.get(node) ??
            (scope ? lookup(scope, name, namespace) : undefined);

        // Unknown globals/API names must not accidentally become macro parameters.
        if (!binding) return `fixed:${name}`;

        let placeholder = nameByBinding.get(binding);
        if (!placeholder) {
            const local = (declarations.get(binding) ?? []).some(id =>
                id.start >= root.start && id.end <= root.end);
            if (local) {
                placeholder = `__clone_local${localCount++}`;
                locals.push({ name: placeholder, example: name });
            } else {
                placeholder = `__clone_arg${captureCount++}`;
                parameters.push({ name: placeholder, kind: "capture" });
                args.push(name);
            }
            nameByBinding.set(binding, placeholder);
        }
        bindings[placeholder] = name;
        recordEdit(node, placeholder, parent, field);
        return placeholder;
    }

    function encode(node: Node, parent?: Node, field?: string): unknown {
        if (["Identifier", "JSXIdentifier", "PrivateIdentifier"].includes(node.type)) {
            return [node.type, normalizeIdentifier(node, parent, field)];
        }
        if (node.type === "Literal") {
            const value = (node as acorn.Literal).value;
            const kind = literalKind(value);
            if (fixedLiteral(parent, field)) {
                return ["Literal", kind, "fixed", scalar(value)];
            }
            const placeholder = `__clone_lit${literalCount++}`;
            parameters.push({ name: placeholder, kind: "literal", literalKind: kind });
            args.push(source.slice(node.start, node.end));
            recordEdit(node, placeholder);
            return ["Literal", kind, "parameter"];
        }
        return encodeFields(node, (child, key) => encode(child, node, key));
    }

    const canonical = JSON.stringify(encode(root));
    const ordered = edits.sort((a, b) => a.start - b.start || b.end - a.end);
    let template = "";
    let cursor = root.start;
    for (const edit of ordered) {
        // Overlapping ranges can arise in unusual TS/JSX syntax. Fail closed.
        if (edit.start < cursor || edit.end > root.end) {
            templateSafe = false;
            continue;
        }
        template += source.slice(cursor, edit.start) + edit.text;
        cursor = edit.end;
    }
    template += source.slice(cursor, root.end);
    // Mark these as needing manual handling instead of silently generating bad code.
    if (!templateSafe) template = source.slice(root.start, root.end);
    return { canonical, template, parameters, locals, arguments: args, bindings, templateSafe };
}

/** Cheap bottom-up fingerprint, including field names and normalized literal types. */
function collectCandidate(
    node: Node, buckets: CandidateBuckets, context: Omit<Candidate, "node" | "size" | "depth">,
    minNodes: number, parent?: Node, field?: string
): { hash: string; size: number; depth: number } {
    let size = 1;
    let depth = 1;
    const signature = (() => {
        if (["Identifier", "JSXIdentifier", "PrivateIdentifier"].includes(node.type)) {
            return [node.type, fixedName(node, parent, field)
                ? `fixed:${(node as acorn.Identifier).name}` : "identifier"];
        }
        if (node.type === "Literal") {
            const value = (node as acorn.Literal).value;
            return ["Literal", literalKind(value), fixedLiteral(parent, field)
                ? scalar(value) : "parameter"];
        }
        return encodeFields(node, (child, key) => {
            const result = collectCandidate(child, buckets, context, minNodes, node, key);
            size += result.size;
            depth = Math.max(depth, result.depth + 1);
            return result.hash;
        });
    })();

    const hash = Bun.hash(JSON.stringify(signature)).toString();
    if (size >= minNodes) {
        const candidates = buckets.get(hash) ?? [];
        candidates.push({ ...context, node, size, depth });
        buckets.set(hash, candidates);
    }
    return { hash, size, depth };
}

/** Stage 2: produce JSON-safe, canonical clone groups with macro data. */
export function buildDictionary(buckets: CandidateBuckets, minOccurrences = 2): Dictionary {
    const dictionary: Dictionary = Object.create(null) as Dictionary;

    for (const candidates of buckets.values()) {
        if (candidates.length < minOccurrences) continue;
        const exactGroups = new Map<string, { candidate: Candidate; normalized: Normalized }[]>();
        for (const candidate of candidates) {
            const normalized = normalizeCandidate(candidate);
            const group = exactGroups.get(normalized.canonical) ?? [];
            group.push({ candidate, normalized });
            exactGroups.set(normalized.canonical, group);
        }

        for (const [canonical, matches] of exactGroups) {
            if (matches.length < minOccurrences) continue;
            const { candidate, normalized } = matches[0]!;
            let hash = Bun.hash(canonical).toString();
            // Defend against collisions in Bun.hash, even between structural groups.
            if (dictionary[hash]?.canonical !== undefined && dictionary[hash]?.canonical !== canonical) {
                let suffix = 1;
                while (dictionary[`${hash}:${suffix}`]) suffix++;
                hash = `${hash}:${suffix}`;
            }
            const occurrences: Occurrence[] = matches.map(({ candidate: item, normalized: norm }) => ({
                repository: item.repository,
                file: item.file,
                start: item.node.start,
                end: item.node.end,
                arguments: norm.arguments,
                bindings: norm.bindings,
            }));
            const subtree: Subtree = {
                hash, canonical, nodeType: candidate.node.type,
                depth: candidate.depth, size: candidate.size,
                count: occurrences.length,
                template: normalized.templateSafe ? normalized.template : "",
                templateReady: matches.every(match => match.normalized.templateSafe),
                parameters: normalized.parameters,
                locals: normalized.locals,
                occurrences,
            };
            dictionary[hash] = subtree;
        }
    }
    return dictionary;
}

/** Useful for tests and for scanning one in-memory source file. */
export function analyseSource(
    source: string, file: string, repository: string,
    buckets: CandidateBuckets, minNodes = 15
): void {
    const ast = parser.parse(source, {
        ecmaVersion: "latest", sourceType: "module", locations: true,
    }) as acorn.Program;
    const resolution = resolveScopes(ast);
    collectDeclarationNodes(ast, resolution);
    for (const node of ast.body) {
        collectCandidate(node, buckets, { resolution, source, file, repository }, minNodes);
    }
}

export default async function analyse(
    directory: Dirent, buckets: CandidateBuckets, minNodes = 15
): Promise<void> {
    const fileSieve = new Bun.Glob(`temp/${directory.name}/**/*.{js,ts,jsx,tsx}`);
    for await (const file of fileSieve.scan(".")) {
        try {
            const source = await Bun.file(file).text();
            analyseSource(source, file, directory.name, buckets, minNodes);
        } catch (error) {
            console.warn(`Skipping ${file}:`, error);
        }
    }
}
