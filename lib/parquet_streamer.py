#!/usr/bin/env python3
"""
High-performance streaming parquet reader for codon-macros.
Streams filtered code files from The Stack (BigCode) parquet shards via stdout.
"""

import argparse
import glob
import json
import os
import sys

try:
    import pyarrow.parquet as pq
except ImportError:
    sys.stderr.write("Error: pyarrow is required. Please install with: pip install pyarrow\n")
    sys.exit(1)


def find_default_data_dir() -> str:
    candidates = ["./data", "./codon-macros/data", "../data", "../../data"]
    for c in candidates:
        if os.path.isdir(c) and glob.glob(os.path.join(c, "*.parquet")):
            return c
    return "./data"


def main():
    parser = argparse.ArgumentParser(description="Stream code files from Parquet shards.")
    parser.add_argument("--data-dir", default=find_default_data_dir(), help="Directory containing .parquet files")
    parser.add_argument("--min-stars", type=int, default=10, help="Minimum repository star count")
    parser.add_argument("--max-line-length", type=int, default=400, help="Maximum line length (filter minified)")
    parser.add_argument("--min-chars", type=int, default=60, help="Minimum file size in characters")
    parser.add_argument("--max-chars", type=int, default=35000, help="Maximum file size in characters")
    parser.add_argument("--max-files", type=int, default=20000, help="Maximum files to stream across all shards")
    parser.add_argument("--batch-size", type=int, default=4000, help="PyArrow batch size")

    args = parser.parse_args()

    files = sorted(glob.glob(os.path.join(args.data_dir, "*.parquet")))
    if not files:
        sys.stderr.write(f"No parquet files found in {args.data_dir}\n")
        sys.exit(1)

    sys.stderr.write(f"Found {len(files)} parquet shards in {args.data_dir}\n")
    sys.stderr.write(f"Filter settings: min_stars={args.min_stars}, max_line_len={args.max_line_length}, max_files={args.max_files}\n")

    files_per_shard = max(1, args.max_files // len(files))
    total_yielded = 0
    excluded_keywords = ["vendor", "dist", "build", ".min.", "bundle.", "node_modules", ".generated."]

    for shard_idx, shard_path in enumerate(files):
        shard_yielded = 0
        try:
            parquet_file = pq.ParquetFile(shard_path)
            for batch in parquet_file.iter_batches(
                batch_size=args.batch_size,
                columns=["content", "max_stars_repo_name", "max_stars_repo_path", "max_stars_count", "max_line_length"]
            ):
                data = batch.to_pydict()
                contents = data["content"]
                repos = data["max_stars_repo_name"]
                paths = data["max_stars_repo_path"]
                stars = data["max_stars_count"]
                line_lens = data["max_line_length"]

                for c, r, p, s, mll in zip(contents, repos, paths, stars, line_lens):
                    if not c or not r or not p:
                        continue
                    if (s or 0) < args.min_stars:
                        continue
                    if (mll or 0) > args.max_line_length:
                        continue
                    c_len = len(c)
                    if c_len < args.min_chars or c_len > args.max_chars:
                        continue

                    p_lower = p.lower()
                    if any(kw in p_lower for kw in excluded_keywords):
                        continue

                    record = json.dumps({"repo": r, "path": p, "content": c})
                    sys.stdout.write(record + "\n")
                    total_yielded += 1
                    shard_yielded += 1

                    if shard_yielded >= files_per_shard or total_yielded >= args.max_files:
                        break

                if shard_yielded >= files_per_shard or total_yielded >= args.max_files:
                    break

        except Exception as e:
            sys.stderr.write(f"Warning: Failed reading shard {shard_path}: {e}\n")

        sys.stderr.write(f"Shard {shard_idx + 1}/{len(files)} ({os.path.basename(shard_path)}): streamed {shard_yielded} files (total: {total_yielded})\n")
        if total_yielded >= args.max_files:
            break

    sys.stdout.flush()
    sys.stderr.write(f"Completed streaming {total_yielded} files.\n")


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, IOError):
        # Pipe closed by downstream consumer (e.g. head or early stop)
        sys.stderr.close()
        sys.exit(0)
