import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { streamParquet } from "../lib/parquet.js";

describe("codon-macros: Parquet Ingestion", () => {
    it("streams code files from parquet shards with filtering", async () => {
        const dataDir = resolve(__dirname, "../data");
        const records: Array<{ repo: string; path: string; content: string }> = [];

        const total = await streamParquet(
            {
                dataDir,
                maxFiles: 20,
                minStars: 10,
            },
            (record) => {
                records.push(record);
            }
        );

        expect(total).toBeGreaterThan(0);
        expect(records.length).toBe(total);
        expect(records[0]).toBeDefined();
        expect(records[0]?.repo).toBeTruthy();
        expect(records[0]?.path).toBeTruthy();
        expect(records[0]?.content.length).toBeGreaterThan(0);
    });
});
