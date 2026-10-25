import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDictionary, scanDirectory, analyseSource, type CandidateBuckets } from "./lib/subtree.js";
import { streamParquet, type ParquetIngestOptions } from "./lib/parquet.js";
import type { DictionaryOptions } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(flag: string, fallback: string = ""): string {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? (args[idx + 1] ?? fallback) : fallback;
}

function findDataDir(): string {
    const candidates = [
        getArg("--data"),
        "./data",
        "./codon-macros/data",
        "../data",
        resolve(__dirname, "../data"),
        resolve(__dirname, "./data"),
    ].filter(Boolean) as string[];

    for (const c of candidates) {
        if (existsSync(c)) return resolve(c);
    }
    return resolve("./data");
}

const customDir = getArg("--dir");
const dataDir = findDataDir();
const minStars = parseInt(getArg("--min-stars", "10"), 10);
const maxFiles = parseInt(getArg("--max-files", "15000"), 10);
const minNodes = parseInt(getArg("--min-nodes", "12"), 10);
const minOccurrences = parseInt(getArg("--min-occurrences", "3"), 10);
const minRepos = parseInt(getArg("--min-repos", "2"), 10);
const minFiles = parseInt(getArg("--min-files", "2"), 10);
const maxParams = parseInt(getArg("--max-params", "6"), 10);
const outFile = getArg("--out", "./dict.json");

const buckets: CandidateBuckets = new Map();

console.log("=================================================");
console.log("   Codon Macro Extraction (Parquet Ingestion)   ");
console.log("=================================================");
console.log(`Config: minNodes=${minNodes}, minOccurrences=${minOccurrences}, minRepos=${minRepos}, minFiles=${minFiles}, maxParams=${maxParams}`);

const t0 = performance.now();
let totalIngested = 0;

if (customDir) {
    const targetDir = resolve(customDir);
    console.log(`Scanning local directory: ${targetDir}`);
    totalIngested = await scanDirectory(targetDir, buckets, basename(targetDir), { minNodes });
    console.log(`Scanned ${totalIngested} files.`);
} else if (existsSync(dataDir)) {
    console.log(`Ingesting from Parquet directory: ${dataDir}`);
    console.log(`Filtering: minStars=${minStars}, maxFiles=${maxFiles}`);

    const parquetOpts: ParquetIngestOptions = {
        dataDir,
        minStars,
        maxFiles,
        maxLineLength: 400,
        minChars: 60,
        maxChars: 35000,
    };

    let parseErrors = 0;
    let lastReport = 0;

    totalIngested = await streamParquet(parquetOpts, (record) => {
        try {
            analyseSource(record.content, record.path, record.repo, buckets, { minNodes });
        } catch {
            parseErrors++;
        }

        const count = totalIngested;
        if (count - lastReport >= 2000) {
            console.log(`... ingested ${count} files (buckets: ${buckets.size})`);
            lastReport = count;
        }
    });

    console.log(`Ingested and analyzed ${totalIngested} code files (${parseErrors} parse skips).`);
} else {
    console.error(`Error: Could not locate parquet dataset at ${dataDir}`);
    console.error("Please supply --data <path-to-parquets> or --dir <path-to-js-dir>");
    process.exit(1);
}

const t1 = performance.now();
console.log(`AST subtree collection completed in ${((t1 - t0) / 1000).toFixed(2)}s.`);
console.log(`Unique structural buckets collected: ${buckets.size}\n`);

// Stage 2: build filtered, scored, deduplicated dictionary
console.log("Building canonical macro dictionary...");
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
console.log(`✅ Saved ${Object.keys(masterDict).length} macros to ${outPath}`);

// If codon directory exists, sync dict.json directly to codon repo
const codonDictPath = resolve(__dirname, "../../codon/dict.json");
const codonAltPath = resolve(__dirname, "../codon/dict.json");
const targetCodonPath = existsSync(dirname(codonDictPath)) ? codonDictPath : (existsSync(dirname(codonAltPath)) ? codonAltPath : null);

if (targetCodonPath) {
    try {
        await copyFile(outPath, targetCodonPath);
        console.log(`✅ Synced macro dictionary to ${targetCodonPath}`);
    } catch {
        // Silently continue
    }
}

console.log("\n=== Top Macro Idioms (Ranked by Compression Score) ===");
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
