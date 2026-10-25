import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ParquetIngestOptions {
    dataDir?: string;
    minStars?: number;
    maxLineLength?: number;
    maxFiles?: number;
    minChars?: number;
    maxChars?: number;
}

export interface CodeRecord {
    repo: string;
    path: string;
    content: string;
}

/**
 * High-performance streaming ingestion from Parquet shards.
 * Spawns the native pyarrow streaming reader and yields code files line by line.
 */
export async function streamParquet(
    options: ParquetIngestOptions,
    onRecord: (record: CodeRecord) => void | Promise<void>
): Promise<number> {
    const streamerPath = resolve(__dirname, "parquet_streamer.py");
    if (!existsSync(streamerPath)) {
        throw new Error(`Parquet streamer script not found at ${streamerPath}`);
    }

    const args: string[] = ["python3", streamerPath];
    if (options.dataDir) args.push("--data-dir", options.dataDir);
    if (options.minStars !== undefined) args.push("--min-stars", String(options.minStars));
    if (options.maxLineLength !== undefined) args.push("--max-line-length", String(options.maxLineLength));
    if (options.maxFiles !== undefined) args.push("--max-files", String(options.maxFiles));
    if (options.minChars !== undefined) args.push("--min-chars", String(options.minChars));
    if (options.maxChars !== undefined) args.push("--max-chars", String(options.maxChars));

    const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "inherit",
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let processed = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            let newlineIdx: number;

            while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);

                if (!line) continue;
                try {
                    const record = JSON.parse(line) as CodeRecord;
                    await onRecord(record);
                    processed++;
                } catch {
                    // Skip malformed lines
                }
            }
        }

        // Process any remainder
        if (buffer.trim()) {
            try {
                const record = JSON.parse(buffer.trim()) as CodeRecord;
                await onRecord(record);
                processed++;
            } catch {
                // Ignore
            }
        }
    } finally {
        await proc.exited;
    }

    return processed;
}
