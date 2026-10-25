import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { simpleGit } from "simple-git";

import analyse, { buildDictionary, scanDirectory, type CandidateBuckets } from "./lib/subtree.js";
import type { DictionaryOptions } from "./types.js";

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(flag: string, fallback: string = ""): string {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? (args[idx + 1] ?? fallback) : fallback;
}

const customDir = getArg("--dir");
const reposFile = getArg("--repos", "./data.json");
const minNodes = parseInt(getArg("--min-nodes", "15"), 10);
const minOccurrences = parseInt(getArg("--min-occurrences", "2"), 10);
const minRepos = parseInt(getArg("--min-repos", "1"), 10);
const minFiles = parseInt(getArg("--min-files", "2"), 10);
const maxParams = parseInt(getArg("--max-params", "6"), 10);
const outFile = getArg("--out", "./dict.json");

const ROOT = "./temp";
const buckets: CandidateBuckets = new Map();

console.log("=== Codon Macro Subtree Extraction ===");
console.log(`Config: minNodes=${minNodes}, minOccurrences=${minOccurrences}, minRepos=${minRepos}, minFiles=${minFiles}, maxParams=${maxParams}`);

if (customDir) {
    const targetDir = resolve(customDir);
    console.log(`Scanning local directory: ${targetDir}`);
    const count = await scanDirectory(targetDir, buckets, basename(targetDir), { minNodes });
    console.log(`Scanned ${count} files.`);
} else if (existsSync(reposFile)) {
    await mkdir(ROOT, { recursive: true });
    let data: string[] = [];
    try {
        data = JSON.parse(await Bun.file(reposFile).text());
    } catch (e) {
        console.error(`Failed to parse ${reposFile}:`, e);
    }

    if (Array.isArray(data) && data.length > 0) {
        console.log(`Processing ${data.length} repositories from ${reposFile}...`);
        const git = simpleGit(ROOT);
        for (const repository of data) {
            const name = basename(repository.replace(/\/$/, "")).replace(/\.git$/, "");
            const destination = join(ROOT, name);
            try {
                if ((await stat(destination)).isDirectory()) {
                    console.log(`[repo] ${repository} already cached.`);
                    continue;
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            try {
                console.log(`[clone] ${repository} -> ${name}`);
                await git.clone(repository, name);
            } catch (error) {
                console.error(`Could not clone ${repository}:`, error);
            }
        }
    }

    const entries = await readdir(ROOT, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "files") continue;
        console.log(`Analyzing repository: ${entry.name}...`);
        await analyse(entry, buckets, minNodes);
    }
} else if (existsSync(ROOT)) {
    console.log(`Scanning cached repositories in ${ROOT}...`);
    const entries = await readdir(ROOT, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "files") continue;
        console.log(`Analyzing repository: ${entry.name}...`);
        await analyse(entry, buckets, minNodes);
    }
} else {
    console.log("No --dir provided and no data.json or temp folder found.");
    console.log("Usage examples:");
    console.log("  bun run index.ts --dir /path/to/repos");
    console.log("  bun run index.ts --repos repos.json --min-repos 2 --out dict.json");
    process.exit(0);
}

console.log(`\nCandidate buckets collected: ${buckets.size}`);

// Stage 2: build filtered, scored, deduplicated dictionary
const options: DictionaryOptions = {
    minOccurrences,
    minRepos,
    minFiles,
    minNodes,
    maxParameters: maxParams,
    filterSubsumed: true,
    keepCommonLiterals: true,
};

const masterDict = buildDictionary(buckets, options);
const outPath = resolve(outFile);
await writeFile(outPath, JSON.stringify(masterDict, null, 2));
console.log(`Saved ${Object.keys(masterDict).length} macros to ${outPath}\n`);

console.log("=== Top Macro Idioms (Ranked by Compression Score) ===");
const stars = Object.entries(masterDict)
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, 15);

for (const [id, group] of stars) {
    console.log(`\nMacro [${group.name ?? id}]: ${group.nodeType} (${group.category})`);
    console.log(`  Size: ${group.size} AST nodes | Matches: ${group.count} (${group.distinctRepos} repos, ${group.distinctFiles} files)`);
    console.log(`  Compression Score: ${group.score} net tokens`);
    console.log(`  Parameters (${group.parameters.length}): ${group.parameters.map(p => `${p.name} [${p.kind}]`).join(", ") || "(none)"}`);
    console.log(`  Locals (${group.locals.length}): ${group.locals.map(l => `${l.name} (${l.example})`).join(", ") || "(none)"}`);
    console.log(`  Template Preview:\n    ${group.template.split("\n").slice(0, 4).join("\n    ")}`);
}
