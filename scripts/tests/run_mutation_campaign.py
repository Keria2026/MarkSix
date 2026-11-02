"""Bounded test-quality campaign in a disposable source copy; never edits checkout."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
TARGETS = ["selection-integrity", "text-entry-retention", "text-entry-number-heads"]
MUTANTS = [
    ("money-limit", "lib/types.ts", "cents <= 9_000_000_000_000_000n", "cents <= 99_000_000_000_000_000n"),
    ("duplicate-choice", "lib/selection.ts", "if (values.includes(value))", "if (false && values.includes(value))"),
    ("unknown-operator-loss", "lib/selection.ts", r".split(/[\s,，、;；:：.。/\[\]【】{}()（）]+/u)", r".split(/[\s\p{P}\p{S}]+/u)"),
    ("head-pool", "lib/text-entry/compiler.ts", "Math.floor(n / 10)", "Math.ceil(n / 10)"),
    ("financial-heading-loss", "lib/text-entry/parser.ts", "if (carriesBetting(parts)) break;", "if (false && carriesBetting(parts)) break;"),
]


def run():
    started = time.monotonic()
    output = ROOT / "test-results" / "rebuild" / "mutations"
    output.mkdir(parents=True, exist_ok=True)
    records = []
    with tempfile.TemporaryDirectory(prefix="marksix-mutations-") as temporary:
        sandbox = Path(temporary)
        shutil.copytree(ROOT / "frontend/src", sandbox / "frontend/src")
        shutil.copytree(ROOT / "frontend/tests/contracts", sandbox / "frontend/tests/contracts")
        (sandbox / "frontend/node_modules").symlink_to(ROOT / "frontend/node_modules", target_is_directory=True)
        (sandbox / "backend/src").mkdir(parents=True)
        shutil.copy(ROOT / "backend/src/default-plays.json", sandbox / "backend/src/default-plays.json")
        command = ["bun", "test", *[f"tests/contracts/{name}.test.ts" for name in TARGETS]]
        for name, relative, old, new in [("baseline", "", "", ""), *MUTANTS]:
            path = sandbox / "frontend/src" / relative if relative else None
            original = path.read_text() if path else ""
            if path:
                if original.count(old) != 1:
                    raise RuntimeError(f"Mutation {name} no longer matches exactly once")
                path.write_text(original.replace(old, new))
            try:
                result = subprocess.run(command, cwd=sandbox / "frontend", capture_output=True, text=True, timeout=60)
            finally:
                if path:
                    path.write_text(original)
            log = result.stdout + result.stderr
            (output / f"{name}.log").write_text(log)
            status = "baseline-pass" if name == "baseline" and result.returncode == 0 else "assertion-killed" if name != "baseline" and result.returncode and "(fail)" in log and "expect(" in log else "escaped" if result.returncode == 0 else "invalid-or-harness-failure"
            records.append({"name": name, "status": status, "returncode": result.returncode})
            if name == "baseline" and result.returncode:
                break
    report = {"mutations": records, "seconds": round(time.monotonic() - started, 2), "scope": "Five selected financial/parser regressions; not a repository-wide mutation score"}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if len(records) != len(MUTANTS) + 1 or any(item["status"] not in {"baseline-pass", "assertion-killed"} for item in records):
        raise SystemExit(1)


if __name__ == "__main__":
    run()
