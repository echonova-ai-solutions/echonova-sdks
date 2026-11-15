#!/usr/bin/env python3
"""Type-check the code samples in the docs against the SDK source. No network, no API key.

Every fenced ```python, ```ts / ```typescript and ```dart block in the READMEs, the guides and
the proxy examples' READMEs is checked, one tool run per language:

- Python: mypy, in python/'s uv environment. A block with a top-level ``await``, ``async with``
  or ``async for`` is wrapped in an ``async def`` (its imports stay at module level).
- TypeScript: tsc --noEmit, strict, as ES modules with top-level await. '@echonova/ai' and
  '@echonova/ai/streaming' resolve to js/src, so a sample is checked against the code, not the
  last build. Needs ``npm ci`` in js/.
- Dart: dart analyze --fatal-infos, in a throwaway package that depends on dart/ by path. A
  block without ``main`` has its imports kept at the top and the rest wrapped in
  ``Future<void> main() async { ... }`` (so a block that declares a class needs its own ``main``).

Write each block so it runs on its own: its own imports, a client created from the
environment (``EchoNova()`` reads ECHONOVA_API_KEY). To leave a block out, put this line
before it, ideally with the reason:

    <!-- snippet: skip (needs Flutter) -->

Libraries that recipes use but the SDK environments don't install are stood in for. For mypy,
web frameworks (FastAPI, Flask, Starlette, Django and the like) and the audio libraries
sounddevice and PyAudio are typed as Any. For tsc, Next.js, Fastify, Hono and Koa are untyped
modules and Express is a small stand-in (TS_EXPRESS below). Dart samples may use package:http
(an SDK dependency) and the real package:shelf, which the Dart SDK's dev dependencies bring in.

    python3 tools/check_snippets.py                  # all of them
    python3 tools/check_snippets.py --lang ts        # one language (python, ts, dart)
    python3 tools/check_snippets.py docs/guides/x.md # chosen files
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

LANGS = {"python": "python", "py": "python", "ts": "ts", "typescript": "ts", "dart": "dart"}

# Web frameworks (webhook recipes) and audio devices (streaming recipes) that samples import but
# that the SDK environments don't install.
PY_UNTYPED = ["fastapi", "flask", "starlette", "django", "uvicorn", "werkzeug", "quart", "sanic", "litestar"]
PY_UNTYPED += ["sounddevice", "pyaudio"]
TS_UNTYPED = ["next", "next/*", "fastify", "hono", "hono/*", "@hono/*", "koa", "@koa/*"]
# Express gets a little more: handlers need typed arguments under strict mode. They are Node's own
# request and response (which Express extends), with anything Express adds typed as any.
TS_EXPRESS = """declare module 'express' {
  import type { IncomingMessage, ServerResponse } from 'node:http';
  export type Request = IncomingMessage & { body: any; [key: string]: any };
  export type Response = ServerResponse & { [key: string]: any };
  export type NextFunction = (err?: unknown) => void;
  export type RequestHandler = (req: Request, res: Response, next: NextFunction) => unknown;
  type Route = (path: string, ...handlers: RequestHandler[]) => Application;
  export interface Application {
    [key: string]: any;
    get: Route; post: Route; put: Route; patch: Route; delete: Route; all: Route;
    use(...handlers: (string | RequestHandler)[]): Application;
  }
  interface Express {
    (): Application;
    Router(): Application;
    [middleware: string]: (options?: object) => RequestHandler;
  }
  const express: Express;
  export default express;
}
"""

FENCE = re.compile(r"^(?P<indent> *)(?P<fence>`{3,}|~{3,})\s*(?P<info>[^`]*)$")
DIRECTIVE = re.compile(r"^\s*<!--\s*snippet:\s*(?P<body>.*?)\s*-->\s*$")
SKIP = re.compile(r"^skip(?:\s*\((?P<reason>[^)]*)\))?$")


def shown(path: Path) -> str:
    """The path as printed: relative to the repository when it is inside it."""
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


@dataclass
class Block:
    path: Path
    line: int  # line of the first code line, 1-based
    lang: str
    code: str
    skip: str | None = None  # the reason, or "" when none was given
    errors: list[str] = field(default_factory=list)

    @property
    def where(self) -> str:
        return f"{shown(self.path)}:{self.line - 1}"

    def md_line(self, line: int) -> int:
        return self.line + line - 1


@dataclass
class Generated:
    """A source file made from a block, with the block's line for each generated line."""

    block: Block
    lines: list[str] = field(default_factory=list)
    origin: list[int | None] = field(default_factory=list)  # 1-based line in the block

    def add(self, text: str, origin: int | None = None) -> None:
        self.lines.append(text)
        self.origin.append(origin)

    def text(self) -> str:
        return "\n".join(self.lines) + "\n"

    def report(self, line: int, message: str) -> None:
        source = self.origin[line - 1] if 0 < line <= len(self.origin) else None
        if source is None:
            self.block.errors.append(f"{self.block.where}: {message}")
        else:
            self.block.errors.append(f"{shown(self.block.path)}:{self.block.md_line(source)}: {message}")


# --- finding the blocks -------------------------------------------------------------------


def default_files() -> list[Path]:
    files = [ROOT / "README.md", ROOT / "python/README.md", ROOT / "js/README.md", ROOT / "dart/README.md"]
    files += sorted((ROOT / "docs/guides").glob("**/*.md"))
    files += sorted((ROOT / "proxy-examples").glob("**/README.md"))
    return [f for f in files if f.is_file() and not _hidden(f)]


def _hidden(path: Path) -> bool:
    return any(part == "node_modules" or part.startswith(".") for part in path.relative_to(ROOT).parts)


def extract(path: Path) -> list[Block]:
    blocks: list[Block] = []
    lines = path.read_text(encoding="utf-8").splitlines()
    i = 0
    directive: tuple[int, str] | None = None  # line and text of the last snippet directive
    while i < len(lines):
        line = lines[i]
        found = DIRECTIVE.match(line)
        if found:
            directive = (i + 1, found["body"])
            i += 1
            continue
        opening = FENCE.match(line)
        if not opening:
            if line.strip():
                directive = None
            i += 1
            continue
        indent, fence = len(opening["indent"]), opening["fence"]
        lang = LANGS.get(opening["info"].strip().split(" ")[0].lower()) if opening["info"].strip() else None
        body: list[str] = []
        j = i + 1
        while j < len(lines):
            closing = lines[j].strip()
            if closing.startswith(fence[0] * len(fence)) and not closing.strip(fence[0]):
                break
            body.append(lines[j][indent:] if not lines[j][:indent].strip() else lines[j].lstrip())
            j += 1
        if lang:
            block = Block(path, i + 2, lang, "\n".join(body) + "\n")
            if directive:
                skip = SKIP.match(directive[1])
                if skip:
                    block.skip = (skip["reason"] or "").strip()
                else:
                    block.errors.append(
                        f"{shown(path)}:{directive[0]}: unknown directive "
                        f"'<!-- snippet: {directive[1]} -->' (only 'skip' or 'skip (reason)')"
                    )
            blocks.append(block)
        directive = None
        i = j + 1
    return blocks


# --- running the tools --------------------------------------------------------------------


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env, check=False)  # noqa: S603
    except FileNotFoundError as e:
        raise SystemExit(f"check_snippets: {cmd[0]} not found ({e})") from e


PROBLEMS: list[str] = []  # failures not tied to one block


def tool_failed(what: str, output: str) -> None:
    PROBLEMS.append(f"{what}:\n{output.strip()}")


# Python


class _TopLevelAwait(ast.NodeVisitor):
    found = False

    def visit_FunctionDef(self, node: ast.AST) -> None:
        pass  # an await in a function is fine

    visit_AsyncFunctionDef = visit_Lambda = visit_FunctionDef

    def visit_Await(self, node: ast.AST) -> None:
        self.found = True

    visit_AsyncFor = visit_AsyncWith = visit_Await

    def visit_comprehension(self, node: ast.comprehension) -> None:
        if node.is_async:
            self.found = True
        self.generic_visit(node)


def python_source(block: Block, index: int) -> Generated | None:
    out = Generated(block)
    try:
        tree = compile(block.code, block.where, "exec", ast.PyCF_ONLY_AST | ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    except SyntaxError as e:
        line = block.md_line(e.lineno or 1)
        block.errors.append(f"{shown(block.path)}:{line}: syntax error: {e.msg}")
        return None
    assert isinstance(tree, ast.Module)
    lines = block.code.splitlines()
    visitor = _TopLevelAwait()
    visitor.visit(tree)
    if not visitor.found:
        for n, text in enumerate(lines, 1):
            out.add(text, n)
        return out
    hoisted: set[int] = set()
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            hoisted.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
    for n in sorted(hoisted):
        out.add(lines[n - 1], n)
    out.add(f"async def _snippet_{index}() -> None:")
    for n, text in enumerate(lines, 1):
        if n not in hoisted:
            out.add("    " + text if text.strip() else "", n)
    out.add("    pass")
    return out


MYPY_LINE = re.compile(r"^(?P<file>[^:]+\.py):(?P<line>\d+): (?P<message>(?:error|note): .*)$")


def check_python(blocks: list[Block], work: Path) -> None:
    folder = work / "python"
    folder.mkdir()
    sources: dict[str, Generated] = {}
    for index, block in enumerate(blocks, 1):
        generated = python_source(block, index)
        if generated:
            name = f"snippet_{index:04d}.py"
            (folder / name).write_text(generated.text(), encoding="utf-8")
            sources[name] = generated
    if not sources:
        return
    untyped = ",".join(f"{m},{m}.*" for m in PY_UNTYPED)
    (work / "mypy.ini").write_text(
        "[mypy]\n"
        "check_untyped_defs = True\n"
        "strict_equality = True\n"
        "warn_redundant_casts = True\n"
        "follow_imports = silent\n"
        "disable_error_code = empty-body\n"  # `def your_hook() -> bytes: ...` stands for the reader's code
        f"cache_dir = {ROOT / '.mypy_cache' / 'snippets'}\n"
        f"\n[mypy-{untyped}]\n"
        "ignore_missing_imports = True\n",
        encoding="utf-8",
    )
    cmd = ["uv", "run", "--project", str(ROOT / "python"), "--quiet", "mypy", "--config-file", str(work / "mypy.ini")]
    cmd += ["--no-error-summary", "--no-pretty", "--show-error-codes", *sorted(sources)]
    result = run(cmd, cwd=folder)
    matched = False
    for line in result.stdout.splitlines():
        found = MYPY_LINE.match(line)
        if not found or found["file"] not in sources:
            continue
        generated = sources[found["file"]]
        if found["message"].startswith("error:"):
            generated.report(int(found["line"]), found["message"])
            matched = True
        elif generated.block.errors:
            generated.block.errors[-1] += "\n    " + found["message"]  # a note on the error before it
    if result.returncode != 0 and not matched:
        tool_failed("mypy failed", result.stdout + result.stderr)


# TypeScript


TSC_LINE = re.compile(r"^(?P<file>[^(]+)\((?P<line>\d+),(?P<col>\d+)\): (?P<message>error .*)$")


def check_ts(blocks: list[Block], work: Path) -> None:
    js = ROOT / "js"
    tsc = js / "node_modules" / "typescript" / "bin" / "tsc"
    if not tsc.exists():
        raise SystemExit("check_snippets: TypeScript is not installed: run `npm ci` in js/")
    folder = work / "ts"
    folder.mkdir()
    sources: dict[str, Generated] = {}
    for index, block in enumerate(blocks, 1):
        generated = Generated(block)
        for n, text in enumerate(block.code.splitlines(), 1):
            generated.add(text, n)
        name = f"snippet_{index:04d}.ts"
        (folder / name).write_text(generated.text(), encoding="utf-8")
        sources[name] = generated
    if not sources:
        return
    shims = "".join(f"declare module '{m}';\n" for m in TS_UNTYPED) + TS_EXPRESS
    (folder / "frameworks.d.ts").write_text(shims, encoding="utf-8")
    config = {
        "compilerOptions": {
            "target": "ES2022",
            "lib": ["ES2022", "ESNext.Disposable", "DOM"],
            "module": "ESNext",
            "moduleResolution": "Bundler",
            "moduleDetection": "force",
            "strict": True,
            "noEmit": True,
            "skipLibCheck": True,
            "types": ["node"],
            "typeRoots": [str(js / "node_modules" / "@types")],
            "paths": {
                "@echonova/ai": [str(js / "src" / "index.ts")],
                "@echonova/ai/streaming": [str(js / "src" / "streaming" / "index.ts")],
            },
        },
        "files": ["frameworks.d.ts", *sorted(sources)],
    }
    (folder / "tsconfig.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    result = run(["node", str(tsc), "-p", "tsconfig.json", "--pretty", "false"], cwd=folder)
    other: list[str] = []
    current: Generated | None = None
    for line in result.stdout.splitlines():
        found = TSC_LINE.match(line)
        if found and found["file"] in sources:
            current = sources[found["file"]]
            current.report(int(found["line"]), found["message"])
        elif found:
            current = None
            other.append(line)  # an error in the SDK source, under the snippets' settings
        elif line.startswith(" ") and current and current.block.errors:
            current.block.errors[-1] += "\n" + line  # the rest of a multi-line message
        elif line.strip():
            other.append(line)
    if other or (result.returncode != 0 and not any(g.block.errors for g in sources.values())):
        tool_failed("tsc reported errors outside the samples", "\n".join(other) + "\n" + result.stderr)


# Dart


MAIN = re.compile(r"^(?:[\w<>?]+\s+)?main\s*\(", re.M)
DIRECTIVE_LINE = re.compile(r"^(?:import|export|library|part)\b")


def dart_source(block: Block) -> Generated:
    out = Generated(block)
    lines = block.code.splitlines()
    if MAIN.search(block.code):
        for n, text in enumerate(lines, 1):
            out.add(text, n)
        return out
    hoisted: set[int] = set()
    n = 1
    while n <= len(lines):
        if DIRECTIVE_LINE.match(lines[n - 1]):
            start = n
            while not lines[n - 1].rstrip().endswith(";") and n < len(lines):
                n += 1
            hoisted.update(range(start, n + 1))
        n += 1
    for n in sorted(hoisted):
        out.add(lines[n - 1], n)
    out.add("Future<void> main() async {")
    for n, text in enumerate(lines, 1):
        if n not in hoisted:
            out.add("  " + text if text.strip() else "", n)
    out.add("}")
    return out


def check_dart(blocks: list[Block], work: Path) -> None:
    folder = work / "dart"
    (folder / "bin").mkdir(parents=True)
    sources: dict[str, Generated] = {}
    for index, block in enumerate(blocks, 1):
        generated = dart_source(block)
        name = f"snippet_{index:04d}.dart"
        (folder / "bin" / name).write_text(generated.text(), encoding="utf-8")
        sources[str((folder / "bin" / name).resolve())] = generated
    if not sources:
        return
    (folder / "pubspec.yaml").write_text(
        "name: echonova_snippets\n"
        "publish_to: none\n"
        "environment:\n  sdk: ^3.5.0\n"
        "dependencies:\n"
        f"  echonova:\n    path: {json.dumps(str(ROOT / 'dart'))}\n"
        "  http: any\n"
        "  shelf: any\n"
        "dev_dependencies:\n  lints: any\n",
        encoding="utf-8",
    )
    (folder / "analysis_options.yaml").write_text(
        "include: package:lints/recommended.yaml\n"
        "analyzer:\n  errors:\n"
        "    unused_local_variable: ignore  # a sample often shows a result it doesn't use\n"
        "    unused_element: ignore  # or a function for the reader to call\n",
        encoding="utf-8",
    )
    got = run(["dart", "pub", "get", "--offline"], cwd=folder)
    if got.returncode != 0:
        got = run(["dart", "pub", "get"], cwd=folder)
    if got.returncode != 0:
        tool_failed("dart pub get failed", got.stdout + got.stderr)
        return
    result = run(["dart", "analyze", "--fatal-infos", "--format=machine", "."], cwd=folder)
    matched = False
    for line in (result.stdout + "\n" + result.stderr).splitlines():
        parts = line.split("|")
        if len(parts) >= 8 and parts[3] in sources:
            severity, code, message = parts[0], parts[2].lower(), "|".join(parts[7:]).strip()
            sources[parts[3]].report(int(parts[4]), f"{severity.lower()}: {message} [{code}]")
            matched = True
    if result.returncode != 0 and not matched:
        tool_failed("dart analyze failed", result.stdout + result.stderr)


CHECKERS = {"python": check_python, "ts": check_ts, "dart": check_dart}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("files", nargs="*", type=Path, help="Markdown files (default: the READMEs and guides)")
    parser.add_argument("--lang", action="append", choices=sorted(CHECKERS), help="check only this language")
    parser.add_argument("--keep", action="store_true", help="keep the generated files and print where they are")
    parser.add_argument("-v", "--verbose", action="store_true", help="list every block")
    args = parser.parse_args()

    files = [f.resolve() for f in args.files] if args.files else default_files()
    langs = args.lang or sorted(CHECKERS)
    blocks = [b for f in files for b in extract(f) if b.lang in langs]
    work = Path(tempfile.mkdtemp(prefix="echonova-snippets-"))
    try:
        jobs = {lang: [b for b in blocks if b.lang == lang and b.skip is None and not b.errors] for lang in langs}
        with ThreadPoolExecutor(len(jobs)) as pool:
            for future in [pool.submit(CHECKERS[lang], todo, work) for lang, todo in jobs.items() if todo]:
                future.result()
    finally:
        if args.keep:
            print(f"generated files kept in {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)

    failed = [b for b in blocks if b.errors]
    for block in blocks if args.verbose else []:
        state = "ok" if block.skip is None else f"skip ({block.skip or 'no reason given'})"
        print(f"{block.where} [{block.lang}] {'FAIL' if block.errors else state}")
    for block in failed:
        print(f"\nFAIL {block.where} ({block.lang} block)")
        for error in block.errors:
            print("  " + error.replace("\n", "\n  "))
    for problem in PROBLEMS:
        print("\nFAIL " + problem.replace("\n", "\n  "))
    print()
    for lang in langs:
        mine = [b for b in blocks if b.lang == lang]
        skipped = sum(b.skip is not None for b in mine)
        bad = sum(bool(b.errors) for b in mine)
        print(f"{lang}: {len(mine) - skipped - bad} passed, {bad} failed, {skipped} skipped")
    return 1 if failed or PROBLEMS else 0


if __name__ == "__main__":
    sys.exit(main())
