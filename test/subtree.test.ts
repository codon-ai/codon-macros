import { describe, expect, it } from "bun:test";
import {
    ALLOWED_MACRO_TYPES,
    analyseSource,
    buildDictionary,
    classifyNodeType,
    generateMnemonicName,
    type CandidateBuckets,
} from "../lib/subtree.js";

describe("codon-macros: Subtree & Macro System", () => {
    it("filters out invalid fragment node types (e.g. Property, JSXOpeningElement)", () => {
        expect(ALLOWED_MACRO_TYPES.has("BlockStatement")).toBe(true);
        expect(ALLOWED_MACRO_TYPES.has("IfStatement")).toBe(true);
        expect(ALLOWED_MACRO_TYPES.has("CallExpression")).toBe(true);
        expect(ALLOWED_MACRO_TYPES.has("JSXElement")).toBe(true);

        expect(ALLOWED_MACRO_TYPES.has("Property")).toBe(false);
        expect(ALLOWED_MACRO_TYPES.has("JSXOpeningElement")).toBe(false);
        expect(ALLOWED_MACRO_TYPES.has("JSXAttribute")).toBe(false);
        expect(ALLOWED_MACRO_TYPES.has("VariableDeclarator")).toBe(false);
    });

    it("classifies AST node types into high-level categories", () => {
        expect(classifyNodeType("IfStatement")).toBe("statement");
        expect(classifyNodeType("BlockStatement")).toBe("statement");
        expect(classifyNodeType("FunctionDeclaration")).toBe("declaration");
        expect(classifyNodeType("VariableDeclaration")).toBe("declaration");
        expect(classifyNodeType("CallExpression")).toBe("expression");
        expect(classifyNodeType("JSXElement")).toBe("expression");
    });

    it("generates readable mnemonic macro names", () => {
        expect(generateMnemonicName("IfStatement", 0)).toBe("m_if_stmt_1");
        expect(generateMnemonicName("CallExpression", 4)).toBe("m_call_expr_5");
        expect(generateMnemonicName("FunctionDeclaration", 2)).toBe("m_function_decl_3");
    });

    it("detects Type-2 clones and extracts parameters cleanly", () => {
        const file1 = `
            function handleUser(req, res) {
                if (!req.body || !req.body.id) {
                    res.status(400).json({ error: "Missing ID" });
                    return;
                }
                const user = db.find(req.body.id);
                res.status(200).json({ data: user });
            }
        `;
        const file2 = `
            function handleItem(request, response) {
                if (!request.body || !request.body.id) {
                    response.status(400).json({ error: "Missing ID" });
                    return;
                }
                const item = db.find(request.body.id);
                response.status(200).json({ data: item });
            }
        `;

        const buckets: CandidateBuckets = new Map();
        analyseSource(file1, "file1.js", "repoA", buckets, 10);
        analyseSource(file2, "file2.js", "repoB", buckets, 10);

        expect(buckets.size).toBeGreaterThan(0);

        const dict = buildDictionary(buckets, {
            minOccurrences: 2,
            minRepos: 2,
            minFiles: 2,
            maxParameters: 6,
        });

        const macros = Object.values(dict);
        expect(macros.length).toBeGreaterThan(0);

        const top = macros[0];
        expect(top).toBeDefined();
        expect(top?.distinctRepos).toBe(2);
        expect(top?.distinctFiles).toBe(2);
        expect(top?.templateReady).toBe(true);
        expect(top?.name).toMatch(/^m_/);
    });

    it("keeps common constant literals (0, 1, empty string) fixed", () => {
        const file1 = `
            function checkA(x) {
                if (x === 0 || x === 1 || x === null) {
                    return 0;
                }
                return 1;
            }
        `;
        const file2 = `
            function checkB(y) {
                if (y === 0 || y === 1 || y === null) {
                    return 0;
                }
                return 1;
            }
        `;

        const buckets: CandidateBuckets = new Map();
        analyseSource(file1, "check1.js", "repoA", buckets, 8);
        analyseSource(file2, "check2.js", "repoB", buckets, 8);

        const dict = buildDictionary(buckets, {
            minOccurrences: 2,
            minRepos: 2,
            keepCommonLiterals: true,
        });

        const macros = Object.values(dict);
        for (const m of macros) {
            // Literals like 0, 1, null should not be converted to lit params
            const litParams = m.parameters.filter(p => p.kind === "literal");
            expect(litParams.length).toBe(0);
        }
    });

    it("subsumes redundant sub-macros inside larger clones", () => {
        const file1 = `
            function fetchWrapper(url) {
                try {
                    const res = fetch(url);
                    if (!res.ok) {
                        throw new Error("Failed");
                    }
                    return res.json();
                } catch (err) {
                    console.error(err);
                    return null;
                }
            }
        `;
        const file2 = `
            function fetchWrapper2(endpoint) {
                try {
                    const response = fetch(endpoint);
                    if (!response.ok) {
                        throw new Error("Failed");
                    }
                    return response.json();
                } catch (e) {
                    console.error(e);
                    return null;
                }
            }
        `;

        const buckets: CandidateBuckets = new Map();
        analyseSource(file1, "f1.js", "repo1", buckets, 10);
        analyseSource(file2, "f2.js", "repo2", buckets, 10);

        const dictWithoutFilter = buildDictionary(buckets, {
            minOccurrences: 2,
            filterSubsumed: false,
        });
        const dictWithFilter = buildDictionary(buckets, {
            minOccurrences: 2,
            filterSubsumed: true,
        });

        // Subsumption filtering should eliminate child AST subtrees that are wholly contained
        // within the larger try/catch block
        expect(Object.keys(dictWithFilter).length).toBeLessThanOrEqual(Object.keys(dictWithoutFilter).length);
    });
});
