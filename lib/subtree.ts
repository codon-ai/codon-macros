import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import * as acorn from "acorn";
import jsxPlugin from "acorn-jsx";
import { tsPlugin } from "@sveltejs/acorn-typescript";

import type { Dictionary, Subtree, Parameter, Local, Occurrence, DictionaryOptions } from "../types.js";

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

/** Standalone AST node types that make syntactically coherent macros. */
export const ALLOWED_MACRO_TYPES = new Set<string>([
    // Complete Statements
    "BlockStatement",
    "IfStatement",
    "TryStatement",
    "ForStatement",
    "ForOfStatement",
    "ForInStatement",
    "WhileStatement",
    "DoWhileStatement",
    "SwitchStatement",
    "ReturnStatement",
    "ExpressionStatement",
    "VariableDeclaration",
    "FunctionDeclaration",
    "ClassDeclaration",

    // Complete Expressions
    "CallExpression",
    "NewExpression",
    "ArrowFunctionExpression",
    "FunctionExpression",
    "ConditionalExpression",
    "BinaryExpression",
    "LogicalExpression",
    "ObjectExpression",
    "ArrayExpression",
    "MemberExpression",
    "TaggedTemplateExpression",

    // JSX Elements (complete element with tags and children)
    "JSXElement",
]);

/** Standard constant literals that should remain fixed rather than parameter slots. */
export const FIXED_COMMON_VALUES = new Set<unknown>([
    0, 1, -1, 2, "", "use strict", "utf-8", "UTF-8",
    true, false, null, undefined,
    "GET", "POST", "PUT", "DELETE", "PATCH",
    "application/json", "text/plain", "text/html",
]);

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
            for (const child of (value as unknown[])) {
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
                for (const item of ((data.elements as (Node | null)[] | undefined) ?? [])) {
                    declarePattern(item, scope);
                }
                return;
            case "ObjectPattern":
                for (const prop of ((data.properties as Node[] | undefined) ?? [])) {
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
        if (node.type === "FunctionExpression") {
            declare(data.id as Node | null, fnScope);
        }
        if (isNode(data.id)) visit(data.id, fnScope);

        if (isNode(data.typeParameters)) visit(data.typeParameters, fnScope);
        for (const param of ((data.params as Node[] | undefined) ?? [])) {
            declarePattern(param, fnScope);
        }
        for (const param of ((data.params as Node[] | undefined) ?? [])) visit(param, fnScope);
        if (isNode(data.returnType)) visit(data.returnType, fnScope);

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
                if (node.type === "SwitchStatement" && isNode(data.discriminant)) {
                    visit(data.discriminant, scope);
                    for (const branch of ((data.cases as Node[] | undefined) ?? [])) visit(branch, blockScope);
                } else {
                    visitChildren(node, blockScope);
                }
                return;
            }
            case "ForStatement":
            case "ForInStatement":
            case "ForOfStatement": {
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
                for (const decl of ((data.declarations as Node[] | undefined) ?? [])) {
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
                    for (const impl of (data.implements as unknown[])) if (isNode(impl)) visit(impl, classScope);
                }
                if (isNode(data.body)) visit(data.body, classScope);
                return;
            }
            case "ImportDeclaration":
                for (const spec of ((data.specifiers as Node[] | undefined) ?? [])) {
                    const local = (spec as AstRecord).local as Node | undefined;
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
                for (const param of ((data.params as Node[] | undefined) ?? [])) {
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

function fixedLiteral(
    parent?: Node,
    field?: string,
    value?: unknown,
    keepCommonLiterals = true
): boolean {
    if (!parent) return false;
    const record = parent as AstRecord;
    if (field === "key" && !record.computed) return true;
    if (field === "source" && /^(Import|Export)/.test(parent.type)) return true;
    if (parent.type === "ImportAttribute") return true;
    if (parent.type === "TSLiteralType") return true;
    if (parent.type === "JSXAttribute" && field === "value") return true;
    if (parent.type === "ExpressionStatement" && record.directive) return true;
    if (keepCommonLiterals && FIXED_COMMON_VALUES.has(value)) return true;
    return false;
}

function fixedName(node: Node, parent?: Node, field?: string): boolean {
    return node.type !== "Identifier" || fixedIdentifier(parent, field);
}

function encodeFields(node: Node, child: (node: Node, key: string) => unknown): unknown {
    const fields: [string, unknown][] = [];
    for (const [key, value] of Object.entries(node).sort(([a], [b]) => a.localeCompare(b))) {
        if (["type", "start", "end", "loc", "range", "raw", "extra", "parent",
             "comments", "leadingComments", "trailingComments"].includes(key)) continue;
        if (isNode(value)) {
            fields.push([key, child(value, key)]);
        } else if (Array.isArray(value)) {
            fields.push([key, (value as unknown[]).map(item => isNode(item) ? child(item, key) : scalar(item))]);
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

function normalizeCandidate(
    candidate: Candidate,
    maxParameters = 6,
    keepCommonLiterals = true
): Normalized {
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
            if (fixedLiteral(parent, field, value, keepCommonLiterals)) {
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
        if (edit.start < cursor || edit.end > root.end) {
            templateSafe = false;
            continue;
        }
        template += source.slice(cursor, edit.start) + edit.text;
        cursor = edit.end;
    }
    template += source.slice(cursor, root.end);
    if (!templateSafe) template = source.slice(root.start, root.end);

    // If candidate has too many parameters, mark templateSafe false to avoid parameter blowout
    if (parameters.length > maxParameters) {
        templateSafe = false;
    }

    return { canonical, template, parameters, locals, arguments: args, bindings, templateSafe };
}

function collectCandidate(
    node: Node,
    buckets: CandidateBuckets,
    context: Omit<Candidate, "node" | "size" | "depth">,
    minNodes: number,
    allowedTypes: Set<string>,
    parent?: Node,
    field?: string,
    keepCommonLiterals = true
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
            return ["Literal", literalKind(value), fixedLiteral(parent, field, value, keepCommonLiterals)
                ? scalar(value) : "parameter"];
        }
        return encodeFields(node, (child, key) => {
            const result = collectCandidate(child, buckets, context, minNodes, allowedTypes, node, key, keepCommonLiterals);
            size += result.size;
            depth = Math.max(depth, result.depth + 1);
            return result.hash;
        });
    })();

    const hash = Bun.hash(JSON.stringify(signature)).toString();
    // Only register candidates that meet minNodes AND belong to coherent macro types!
    if (size >= minNodes && allowedTypes.has(node.type)) {
        const candidates = buckets.get(hash) ?? [];
        candidates.push({ ...context, node, size, depth });
        buckets.set(hash, candidates);
    }
    return { hash, size, depth };
}

export function classifyNodeType(nodeType: string): "statement" | "expression" | "declaration" {
    if (nodeType.endsWith("Declaration")) return "declaration";
    if (nodeType.endsWith("Statement") || nodeType === "CatchClause") return "statement";
    return "expression";
}

export function generateMnemonicName(nodeType: string, index: number): string {
    const typePrefix = nodeType
        .replace(/([A-Z])/g, "_$1")
        .toLowerCase()
        .replace(/^_/, "")
        .replace(/_statement$/, "_stmt")
        .replace(/_expression$/, "_expr")
        .replace(/_declaration$/, "_decl");
    return `m_${typePrefix}_${index + 1}`;
}

/** Check if subtree B is subsumed by an already selected larger subtree A */
function isSubsumed(
    candidate: Subtree,
    selected: Subtree[]
): boolean {
    for (const parent of selected) {
        if (parent.size <= candidate.size) continue;
        let containedCount = 0;
        for (const cOcc of candidate.occurrences) {
            const isContained = parent.occurrences.some(pOcc =>
                pOcc.repository === cOcc.repository &&
                pOcc.file === cOcc.file &&
                pOcc.start <= cOcc.start &&
                pOcc.end >= cOcc.end
            );
            if (isContained) containedCount++;
        }
        // If more than 75% of candidate occurrences are contained inside the parent
        // and candidate does not have significantly higher independent frequency
        if (containedCount >= candidate.count * 0.75 && candidate.count <= parent.count * 1.5) {
            return true;
        }
    }
    return false;
}

/** Stage 2: produce JSON-safe, canonical clone groups with macro data and compression scoring. */
export function buildDictionary(
    buckets: CandidateBuckets,
    options: DictionaryOptions | number = 2
): Dictionary {
    const opts: DictionaryOptions = typeof options === "number" ? { minOccurrences: options } : options;
    const minOccurrences = opts.minOccurrences ?? 2;
    const minRepos = opts.minRepos ?? 1;
    const minFiles = opts.minFiles ?? 1;
    const maxParameters = opts.maxParameters ?? 6;
    const keepCommonLiterals = opts.keepCommonLiterals ?? true;
    const filterSubsumed = opts.filterSubsumed ?? true;

    const rawList: Subtree[] = [];

    for (const candidates of buckets.values()) {
        if (candidates.length < minOccurrences) continue;
        const exactGroups = new Map<string, { candidate: Candidate; normalized: Normalized }[]>();
        for (const candidate of candidates) {
            const normalized = normalizeCandidate(candidate, maxParameters, keepCommonLiterals);
            // Skip non-template-safe entries (e.g. parameter overflow or overlapping text edits)
            if (!normalized.templateSafe) continue;
            const group = exactGroups.get(normalized.canonical) ?? [];
            group.push({ candidate, normalized });
            exactGroups.set(normalized.canonical, group);
        }

        for (const [canonical, matches] of exactGroups) {
            if (matches.length < minOccurrences) continue;
            const { candidate, normalized } = matches[0]!;

            const distinctRepos = new Set(matches.map(m => m.candidate.repository));
            const distinctFiles = new Set(matches.map(m => `${m.candidate.repository}:${m.candidate.file}`));

            if (distinctRepos.size < minRepos) continue;
            if (distinctFiles.size < minFiles) continue;
            if (normalized.parameters.length > maxParameters) continue;

            const occurrences: Occurrence[] = matches.map(({ candidate: item, normalized: norm }) => ({
                repository: item.repository,
                file: item.file,
                start: item.node.start,
                end: item.node.end,
                arguments: norm.arguments,
                bindings: norm.bindings,
            }));

            // Net Token Economy Model:
            // ~1.5 tokens saved per AST node vs ~2 base tokens + 1.5 tokens per parameter for macro invocation
            const tokenSavingsPerOccurrence = Math.max(0, (candidate.size * 1.5) - (2 + normalized.parameters.length * 1.5));
            const rawSavings = tokenSavingsPerOccurrence * occurrences.length;
            const diversityMultiplier = Math.sqrt(distinctRepos.size);
            const score = Math.round(rawSavings * diversityMultiplier);

            let hash = Bun.hash(canonical).toString();
            const subtree: Subtree = {
                hash,
                canonical,
                nodeType: candidate.node.type,
                category: classifyNodeType(candidate.node.type),
                depth: candidate.depth,
                size: candidate.size,
                count: occurrences.length,
                distinctRepos: distinctRepos.size,
                distinctFiles: distinctFiles.size,
                score,
                template: normalized.template,
                templateReady: true,
                parameters: normalized.parameters,
                locals: normalized.locals,
                occurrences,
            };
            rawList.push(subtree);
        }
    }

    // Sort by score descending
    rawList.sort((a, b) => b.score - a.score || b.size - a.size);

    // Apply subsumption filtering
    const selected: Subtree[] = [];
    for (const item of rawList) {
        if (filterSubsumed && isSubsumed(item, selected)) {
            continue;
        }
        selected.push(item);
    }

    // Assign mnemonic names and populate output dictionary
    const dictionary: Dictionary = Object.create(null) as Dictionary;
    selected.forEach((subtree, index) => {
        subtree.name = generateMnemonicName(subtree.nodeType, index);
        let finalHash = subtree.hash;
        if (dictionary[finalHash] && dictionary[finalHash]?.canonical !== subtree.canonical) {
            let suffix = 1;
            while (dictionary[`${finalHash}:${suffix}`]) suffix++;
            finalHash = `${finalHash}:${suffix}`;
            subtree.hash = finalHash;
        }
        dictionary[finalHash] = subtree;
    });

    return dictionary;
}

/** Analyze one in-memory source file. */
export function analyseSource(
    source: string,
    file: string,
    repository: string,
    buckets: CandidateBuckets,
    options: DictionaryOptions | number = 15
): void {
    const opts: DictionaryOptions = typeof options === "number" ? { minNodes: options } : options;
    const minNodes = opts.minNodes ?? 15;
    const allowedTypes = opts.allowedNodeTypes ?? ALLOWED_MACRO_TYPES;
    const keepCommonLiterals = opts.keepCommonLiterals ?? true;

    try {
        const ast = parser.parse(source, {
            ecmaVersion: "latest",
            sourceType: "module",
            locations: true,
        }) as acorn.Program;
        const resolution = resolveScopes(ast);
        collectDeclarationNodes(ast, resolution);
        for (const node of ast.body) {
            collectCandidate(
                node,
                buckets,
                { resolution, source, file, repository },
                minNodes,
                allowedTypes,
                undefined,
                undefined,
                keepCommonLiterals
            );
        }
    } catch {
        // Silently skip unparseable files
    }
}

/** Recursively scan an arbitrary directory for JS/TS/JSX/TSX files. */
export async function scanDirectory(
    dirPath: string,
    buckets: CandidateBuckets,
    repositoryName: string = basename(dirPath),
    options: DictionaryOptions | number = 15
): Promise<number> {
    const opts: DictionaryOptions = typeof options === "number" ? { minNodes: options } : options;
    let scannedFiles = 0;

    async function walk(currentDir: string): Promise<void> {
        let entries: Dirent[];
        try {
            entries = await readdir(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") {
                continue;
            }
            const fullPath = join(currentDir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
                try {
                    const source = await Bun.file(fullPath).text();
                    analyseSource(source, fullPath, repositoryName, buckets, opts);
                    scannedFiles++;
                } catch {
                    // Ignore unreadable files
                }
            }
        }
    }

    await walk(dirPath);
    return scannedFiles;
}

export default async function analyse(
    directory: Dirent,
    buckets: CandidateBuckets,
    minNodes = 15
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
