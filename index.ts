import data from "./data.json";
import { simpleGit } from "simple-git";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import analyse, { buildDictionary, type CandidateBuckets } from "./lib/subtree.js";

const ROOT = "./temp";
const MIN_NODES = 15;
const MIN_OCCURRENCES = 2;
await mkdir(ROOT, { recursive: true });

const git = simpleGit(ROOT);
for (const repository of data) {
    // Clone into a deterministic directory; only ignore a genuinely existing checkout.
    const name = basename(repository.replace(/\/$/, "")).replace(/\.git$/, "");
    const destination = join(ROOT, name);
    try {
        if ((await stat(destination)).isDirectory()) {
            console.log(`${repository} already loaded...`);
            continue;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
        await git.clone(repository, name);
    } catch (error) {
        console.error(`Could not clone ${repository}`, error);
    }
}

const entries = await readdir(ROOT, { withFileTypes: true });
const buckets: CandidateBuckets = new Map();
for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "files") continue;
    await analyse(entry, buckets, MIN_NODES);
}

// Stage 2: only canonicalize candidates that share a cheap structural hash.
const masterDict = buildDictionary(buckets, MIN_OCCURRENCES);
await writeFile(join(ROOT, "dict.json"), JSON.stringify(masterDict, null, 2));

console.log("=== Top clone groups ===");
const stars = Object.entries(masterDict)
    .sort(([, a], [, b]) => b.size * b.count - a.size * a.count)
    .slice(0, 10);

for (const [id, group] of stars) {
    console.log(`\nClone ${id}: ${group.nodeType} (${group.size} nodes; ${group.count} matches)`);
    console.log(`Template: ${group.template}`);
    console.log(`Parameters: ${group.parameters.map(p => p.name).join(", ") || "(none)"}`);
    const example = group.occurrences[0];
    if (example) {
        console.log(`Example call arguments: ${JSON.stringify(example.arguments)}`);
        console.log(`Example location: ${example.file}:${example.start}-${example.end}`);
    }
    // For expression subtrees, this is a useful starting point for macro extraction.
    // Do not automatically wrap statements, returns, awaits, etc. in functions.
    if (group.templateReady && /^(BinaryExpression|LogicalExpression|ConditionalExpression)$/.test(group.nodeType)) {
        console.log(`Macro sketch: const macro = (${group.parameters.map(p => p.name).join(", ")}) => (${group.template});`);
    }
}
