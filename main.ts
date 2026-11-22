// mend: one patch tool for every AI edit format.
//
// mend reads a patch written by an AI model — a unified diff (whose line
// numbers are often wrong), a set of SEARCH/REPLACE blocks, a V4A patch, or
// JSON text-editor tool calls — and applies it to the tree of text files in
// the working directory. Every edit lands, or none does: the patch is read
// whole first, every edit is tried against an in-memory copy of the tree,
// and only when all of them succeed are the changed files written out.
//
// The contract is SPEC.md (version 1). This file is written to it directly:
// the command line and exit codes, safe paths, the four formats, the three
// matching tiers (exact, trailing whitespace, full whitespace), and the
// all-or-nothing write. Node 22 and its standard library alone, no network.
//
// When MAKEFUN_ENV_URL is set, the process is a trial run instead: it hands
// over to runner.ts, which reads the checks from the env and runs this file
// on each one. That hand-over stays at the bottom of this file.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const isBlank = (line: string): boolean => line.trim() === '';

/** Only spaces and tabs count as whitespace when lines are compared. */
const trimRightSpaces = (s: string): string => s.replace(/[ \t]+$/, '');
const trimSpaces = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingSpaces = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const onlySpaces = (s: string): boolean => s === '' || /^[ \t]+$/.test(s);

/**
 * A patch's lines (SPEC section 3): split at \n, one trailing \r removed
 * from each, and no empty piece after a final \n.
 */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

interface FileShape {
  /** '\r\n' when the first line feed follows a carriage return, else '\n'. */
  br: string;
  lines: string[];
  /** Whether the text ends with its line break. */
  final: boolean;
}

/** A file's text broken into its lines (SPEC section 3). */
function splitFile(text: string): FileShape {
  if (text === '') return { br: '\n', lines: [], final: false };
  const firstLf = text.indexOf('\n');
  const br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

/** A file's lines written back (SPEC section 3); a file of no lines is empty. */
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** A path is safe when it is not empty, not absolute, holds no backslash,
 *  and none of its segments is empty, '.' or '..' (SPEC section 3). */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Byte order of UTF-8 paths (SPEC section 2). */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** An exit-2 parse failure naming a 1-based patch line. */
class ParseFault extends Error {
  readonly lineNo: number;
  constructor(lineNo: number) {
    super(`parse ${lineNo}`);
    this.lineNo = lineNo;
  }
}

/** One edit's failure: its code and the path it concerns (SPEC section 2). */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/**
 * The tree as the edits leave it. `pending` holds what edits changed
 * (null: deleted); anything else is read from disk the first time it is
 * needed and then remembered, so the original bytes stay available for the
 * final report even after an edit overwrote them in memory.
 */
class WorkTree {
  private readonly disk = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();

  original(path: string): string | null {
    if (!this.disk.has(path)) {
      let value: string | null = null;
      try {
        if (statSync(path).isFile()) value = readFileSync(path, 'utf8');
      } catch {
        value = null;
      }
      this.disk.set(path, value);
    }
    return this.disk.get(path)!;
  }

  read(path: string): string | null {
    return this.pending.has(path) ? this.pending.get(path)! : this.original(path);
  }

  set(path: string, value: string | null): void {
    this.pending.set(path, value);
  }
}

/** A move that succeeded, for the `R old -> new` output line. */
interface MoveRecord {
  from: string;
  to: string;
}

/** One edit: it mutates the tree or throws an EditFault, and reports a
 *  move when it moved a file. */
type Edit = (tree: WorkTree) => MoveRecord | null;

// ---------------------------------------------------------------------------
// Matching lines (SPEC section 5)
// ---------------------------------------------------------------------------

/** Whether two lines are equal at one matching tier. */
function linesEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRightSpaces(a) === trimRightSpaces(b);
  return trimSpaces(a) === trimSpaces(b);
}

/** Where old lines occur in a file at the first tier that has any. */
interface LineMatch {
  tier: number;
  spots: number[];
}

function findLineMatch(
  oldLines: string[],
  fileLines: string[],
  strict: boolean,
  from = 0,
  mustEndAtEnd = false,
): LineMatch | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const spots: number[] = [];
    for (let i = from; i + oldLines.length <= fileLines.length; i += 1) {
      if (mustEndAtEnd && i + oldLines.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (!linesEqualAt(oldLines[j]!, fileLines[i + j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) spots.push(i);
    }
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor. */
function findAnchor(anchor: string, fileLines: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < fileLines.length; i += 1) {
      if (linesEqualAt(anchor, fileLines[i]!, tier)) return i;
    }
  }
  return -1;
}

/**
 * One line of the replacement text: a context line names its index in the
 * old lines (it is written as the file's own matched line), any other line
 * is written as the patch wrote it (re-indented at tier 2).
 */
interface NewPart {
  text: string;
  ctx: number | null;
}

/** Build the replacement lines for a match at `at` with the given tier. */
function renderNew(
  parts: NewPart[],
  oldLines: string[],
  fileLines: string[],
  at: number,
  tier: number,
): string[] {
  let fileLead = '';
  let oldLead = '';
  if (tier === 2 && oldLines.length > 0) {
    fileLead = leadingSpaces(fileLines[at] ?? '');
    oldLead = leadingSpaces(oldLines[0] ?? '');
  }
  const out: string[] = [];
  for (const part of parts) {
    if (part.ctx !== null) {
      out.push(fileLines[at + part.ctx]!);
      continue;
    }
    const text = part.text;
    if (tier === 2 && !onlySpaces(text) && text.startsWith(oldLead)) {
      out.push(fileLead + text.slice(oldLead.length));
    } else {
      out.push(text);
    }
  }
  return out;
}

/** Split a hunk or chunk body into its old lines and its new parts. */
function splitBody(body: BodyLine[]): { oldLines: string[]; newParts: NewPart[] } {
  const oldLines: string[] = [];
  const newParts: NewPart[] = [];
  for (const item of body) {
    if (item.kind === 'backslash') continue;
    if (item.kind === 'ctx') {
      oldLines.push(item.text);
      newParts.push({ text: item.text, ctx: oldLines.length - 1 });
    } else if (item.kind === 'old') {
      oldLines.push(item.text);
    } else {
      newParts.push({ text: item.text, ctx: null });
    }
  }
  return { oldLines, newParts };
}

/** One line of a hunk or chunk body. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}

/**
 * Whether a `\` line follows the hunk's last context or `+` line: that is
 * what decides whether a result that runs to the end of the file ends with
 * a line break (SPEC section 6).
 */
function backslashAfterLastAdded(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const item = body[i]!;
    if (item.kind === 'ctx' || item.kind === 'new') {
      return body[i + 1]?.kind === 'backslash';
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when the value is not one. */
function jsonEditObject(value: unknown, strict: boolean): Edit | null {
  void strict;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== 'string') return null;
  const path = obj.path;

  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    const text = obj.file_text;
    return (tree) => {
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      if (tree.read(path) !== null) throw new EditFault('exists', path);
      tree.set(path, text);
      return null;
    };
  }

  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') return null;
    const needleRaw = obj.old_str;
    const replacementRaw = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      const before = tree.read(path);
      if (before === null) throw new EditFault('missing', path);
      const crlf = splitFile(before).br === '\r\n';
      const normalize = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const body = normalize(before);
      const needle = normalize(needleRaw);
      const replacement = normalize(replacementRaw);
      let count = 0;
      for (let k = body.indexOf(needle); k >= 0; k = body.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', path);
      if (count > 1) throw new EditFault('ambiguous', path);
      const at = body.indexOf(needle);
      const out = body.slice(0, at) + replacement + body.slice(at + needle.length);
      tree.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
      return null;
    };
  }

  if (obj.command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    const lineNo = obj.insert_line;
    const added = splitPatch(obj.new_str);
    return (tree) => {
      if (!isSafePath(path)) throw new EditFault('unsafe', path);
      const before = tree.read(path);
      if (before === null) throw new EditFault('missing', path);
      const shape = splitFile(before);
      if (lineNo < 0 || lineNo > shape.lines.length) throw new EditFault('no-match', path);
      const out = shape.lines.slice(0, lineNo).concat(added, shape.lines.slice(lineNo));
      tree.set(path, joinFile(out, shape.br, shape.final));
      return null;
    };
  }

  return null;
}

/** Read a patch as JSON: one array of edit objects, or one object a line. */
function parseJson(text: string, lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(value)) throw new ParseFault(first + 1);
    for (const item of value) {
      const edit = jsonEditObject(item, strict);
      if (edit === null) throw new ParseFault(first + 1);
      edits.push(edit);
    }
  } else {
    for (let i = 0; i < lines.length; i += 1) {
      if (isBlank(lines[i]!)) continue;
      let edit: Edit | null = null;
      try {
        edit = jsonEditObject(JSON.parse(lines[i]!), strict);
      } catch {
        edit = null;
      }
      if (edit === null) throw new ParseFault(i + 1);
      edits.push(edit);
    }
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** The -A number of the hunk header. */
  oldStart: number;
  body: BodyLine[];
}

interface DiffSection {
  /** From `diff --git a/<X> b/<Y>`, when the section started with one. */
  gitOld: string | null;
  gitNew: string | null;
  /** From a `--- ` / `+++ ` pair. */
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

/** A `--- ` or `+++ ` path: after the four characters, up to the first tab,
 *  surrounding spaces removed, a leading `a/` or `b/` removed. */
function dashPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

/**
 * Read one hunk body starting at `start`. The body ends at the first line
 * that is not a body line, at a `diff --git ` line, or at a `--- ` line
 * followed by a `+++ ` line. Empty lines at the end of a body are not part
 * of it. Returns the body and the index where reading stopped.
 */
function readHunkBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let j = start;
  while (j < lines.length) {
    const line = lines[j]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') {
      body.push({ kind: 'ctx', text: '' });
      j += 1;
      continue;
    }
    const head = line[0]!;
    if (head === ' ') {
      body.push({ kind: 'ctx', text: line.slice(1) });
    } else if (head === '-') {
      body.push({ kind: 'old', text: line.slice(1) });
    } else if (head === '+') {
      body.push({ kind: 'new', text: line.slice(1) });
    } else if (head === '\\') {
      body.push({ kind: 'backslash', text: line.slice(1) });
    } else {
      break;
    }
    j += 1;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  return { body, next: j };
}

/** Parse a unified patch into one edit per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: DiffSection[] = [];
  const blankSection = (): DiffSection => ({
    gitOld: null,
    gitNew: null,
    dashOld: null,
    dashNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let current: DiffSection | null = null;
  let seenHunk = false;
  let i = 0;

  const startHunk = (at: number): number => {
    const head = HUNK_HEAD.exec(lines[at]!)!;
    const { body, next } = readHunkBody(lines, at + 1);
    current!.hunks.push({ oldStart: Number(head[1]), body });
    seenHunk = true;
    return next;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      current = blankSection();
      current.gitOld = m[1]!;
      current.gitNew = m[2]!;
      sections.push(current);
      seenHunk = false;
      i += 1;
      continue;
    }
    if (current === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        current = blankSection();
        current.dashOld = dashPath(line);
        current.dashNew = dashPath(lines[i + 1]!);
        sections.push(current);
        seenHunk = false;
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new ParseFault(i + 1);
      i += 1;
      continue;
    }
    if (!seenHunk) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new ParseFault(i + 2);
        if (current.dashOld === null) current.dashOld = dashPath(line);
        if (current.dashNew === null) current.dashNew = dashPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        if (current.dashNew === null) current.dashNew = dashPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        current.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        current.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        current.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        current.deletedFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        if (!HUNK_HEAD.test(line)) throw new ParseFault(i + 1);
        i = startHunk(i);
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      current = blankSection();
      current.dashOld = dashPath(line);
      current.dashNew = dashPath(lines[i + 1]!);
      sections.push(current);
      seenHunk = false;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!HUNK_HEAD.test(line)) throw new ParseFault(i + 1);
      i = startHunk(i);
      continue;
    }
    i += 1;
  }

  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((section) => makeUnifiedEdit(section, strict));
}

/** Apply one section's hunks to a file's text, in order. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const shape = splitFile(text);
  let fileLines = shape.lines;
  let final = shape.final;
  let drift = 0;
  for (const hunk of hunks) {
    const { oldLines, newParts } = splitBody(hunk.body);
    const noBreak = backslashAfterLastAdded(hunk.body);
    if (oldLines.length === 0) {
      const at = Math.max(0, Math.min(hunk.oldStart + drift, fileLines.length));
      const touchesEnd = at === fileLines.length;
      const inserted = renderNew(newParts, oldLines, fileLines, at, 0);
      fileLines = fileLines.slice(0, at).concat(inserted, fileLines.slice(at));
      if (touchesEnd) final = !noBreak;
    } else {
      const match = findLineMatch(oldLines, fileLines, strict);
      if (match === null) throw new EditFault('no-match', failPath);
      const target = hunk.oldStart - 1 + drift;
      let best = match.spots[0]!;
      let bestGap = Math.abs(best - target);
      for (const spot of match.spots) {
        const gap = Math.abs(spot - target);
        if (gap < bestGap) {
          best = spot;
          bestGap = gap;
        }
      }
      const touchesEnd = best + oldLines.length === fileLines.length;
      const replacement = renderNew(newParts, oldLines, fileLines, best, match.tier);
      fileLines = fileLines
        .slice(0, best)
        .concat(replacement, fileLines.slice(best + oldLines.length));
      if (touchesEnd) final = !noBreak;
    }
    drift += newParts.length - oldLines.length;
  }
  return joinFile(fileLines, shape.br, final);
}

/** One unified section as an edit. */
function makeUnifiedEdit(section: DiffSection, strict: boolean): Edit {
  const oldPath = section.dashOld ?? section.renameFrom ?? section.gitOld;
  const newPath = section.dashNew ?? section.renameTo ?? section.gitNew;
  const oldIsNull = oldPath === '/dev/null' || oldPath === null;
  const newIsNull = newPath === '/dev/null' || newPath === null;
  return (tree) => {
    if (oldIsNull || section.newFile) {
      // A creation: the new path must not exist, and the file is the `+`
      // lines of all its hunks, in order.
      const dest = newPath ?? '/dev/null';
      if (!isSafePath(dest)) throw new EditFault('unsafe', dest);
      if (tree.read(dest) !== null) throw new EditFault('exists', dest);
      const added: string[] = [];
      let lastPlusNoBreak = false;
      for (const hunk of section.hunks) {
        for (let k = 0; k < hunk.body.length; k += 1) {
          if (hunk.body[k]!.kind === 'new') {
            added.push(hunk.body[k]!.text);
            lastPlusNoBreak = hunk.body[k + 1]?.kind === 'backslash';
          }
        }
      }
      tree.set(dest, added.length === 0 ? '' : added.join('\n') + (lastPlusNoBreak ? '' : '\n'));
      return null;
    }
    if (newIsNull || section.deletedFile) {
      // A deletion: the old path must exist; its hunks are not read.
      const src = oldPath ?? '/dev/null';
      if (!isSafePath(src)) throw new EditFault('unsafe', src);
      if (tree.read(src) === null) throw new EditFault('missing', src);
      tree.set(src, null);
      return null;
    }
    if (oldPath !== newPath) {
      // A move: the old path exists, the new one does not, and the hunks
      // apply to the old file's lines.
      if (!isSafePath(oldPath!)) throw new EditFault('unsafe', oldPath!);
      if (!isSafePath(newPath!)) throw new EditFault('unsafe', newPath!);
      const before = tree.read(oldPath!);
      if (before === null) throw new EditFault('missing', oldPath!);
      if (tree.read(newPath!) !== null) throw new EditFault('exists', newPath!);
      const after = applyHunks(before, section.hunks, strict, oldPath!);
      tree.set(oldPath!, null);
      tree.set(newPath!, after);
      return { from: oldPath!, to: newPath! };
    }
    // A change of the one path, which must exist.
    if (!isSafePath(oldPath!)) throw new EditFault('unsafe', oldPath!);
    const before = tree.read(oldPath!);
    if (before === null) throw new EditFault('missing', oldPath!);
    tree.set(oldPath!, applyHunks(before, section.hunks, strict, oldPath!));
    return null;
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const candidate = lines[j]!;
      if (candidate.trim() === '') continue;
      if (candidate.trim().startsWith('```')) continue;
      path = candidate.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchAt + 1);
      path = prevPath;
    }
    let split = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        split = j;
        break;
      }
    }
    if (split < 0) throw new ParseFault(searchAt + 1);
    let close = -1;
    for (let j = split + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        close = j;
        break;
      }
    }
    if (close < 0) throw new ParseFault(searchAt + 1);
    const oldLines = lines.slice(searchAt + 1, split);
    const newLines = lines.slice(split + 1, close);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = close;
    i = close + 1;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function makeSearchReplaceEdit(
  path: string,
  oldLines: string[],
  newLines: string[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.read(path) !== null) throw new EditFault('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return null;
    }
    const before = tree.read(path);
    if (before === null) throw new EditFault('missing', path);
    const shape = splitFile(before);
    const match = findLineMatch(oldLines, shape.lines, strict);
    if (match === null) throw new EditFault('no-match', path);
    if (match.spots.length > 1) throw new EditFault('ambiguous', path);
    const at = match.spots[0]!;
    const parts: NewPart[] = newLines.map((text) => ({ text, ctx: null }));
    const replacement = renderNew(parts, oldLines, shape.lines, at, match.tier);
    const out = shape.lines
      .slice(0, at)
      .concat(replacement, shape.lines.slice(at + oldLines.length));
    tree.set(path, joinFile(out, shape.br, shape.final));
    return null;
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** Null when the chunk has no anchor. */
  anchor: string | null;
  /** Whether a `*** End of File` line closed the chunk. */
  eof: boolean;
  body: BodyLine[];
}

function v4aSectionKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

function v4aSectionPath(line: string, kind: 'add' | 'delete' | 'update'): string {
  const prefix =
    kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
  return line.slice(prefix.length).trim();
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = v4aSectionKind(line);
    if (kind === null) throw new ParseFault(i + 1);
    const path = v4aSectionPath(line, kind);
    let end = last;
    for (let k = i + 1; k < last; k += 1) {
      if (v4aSectionKind(lines[k]!) !== null) {
        end = k;
        break;
      }
    }
    // Blank lines at the end of a section are not part of it.
    let bodyEnd = end;
    while (bodyEnd > i + 1 && isBlank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = i + 1; k < bodyEnd; k += 1) {
        const bodyLine = lines[k]!;
        if (bodyLine.startsWith('+')) fileLines.push(bodyLine.slice(1));
        else if (bodyLine === '') fileLines.push('');
        else throw new ParseFault(k + 1);
      }
      edits.push(makeV4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (let k = i + 1; k < bodyEnd; k += 1) {
        if (!isBlank(lines[k]!)) throw new ParseFault(k + 1);
      }
      edits.push(makeV4aDeleteEdit(path));
    } else {
      edits.push(parseV4aUpdate(path, lines, i, bodyEnd, strict));
    }
    i = end;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function parseV4aUpdate(
  path: string,
  lines: string[],
  headAt: number,
  bodyEnd: number,
  strict: boolean,
): Edit {
  let moveTo: string | null = null;
  let j = headAt + 1;
  if (j < bodyEnd && lines[j]!.startsWith('*** Move to: ')) {
    moveTo = lines[j]!.slice('*** Move to: '.length).trim();
    j += 1;
  }
  const chunks: V4aChunk[] = [];
  let open: V4aChunk | null = null;
  let seenChunk = false;
  while (j < bodyEnd) {
    const line = lines[j]!;
    if (line.startsWith('@@')) {
      if (open !== null) {
        chunks.push(open);
        open = null;
      }
      open = { anchor: line.slice(2).trim() === '' ? null : line.slice(2).trim(), eof: false, body: [] };
      seenChunk = true;
      j += 1;
      continue;
    }
    if (line === '*** End of File') {
      if (open === null) throw new ParseFault(j + 1);
      open.eof = true;
      chunks.push(open);
      open = null;
      seenChunk = true;
      j += 1;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (open === null) {
        // A body line starts a chunk only for the first chunk; after one
        // has closed, a body line with no `@@` before it is not a chunk.
        if (seenChunk) throw new ParseFault(j + 1);
        open = { anchor: null, eof: false, body: [] };
        seenChunk = true;
      }
      const head = line[0];
      if (head === ' ') open.body.push({ kind: 'ctx', text: line.slice(1) });
      else if (head === '-') open.body.push({ kind: 'old', text: line.slice(1) });
      else if (head === '+') open.body.push({ kind: 'new', text: line.slice(1) });
      else open.body.push({ kind: 'ctx', text: '' });
      j += 1;
      continue;
    }
    throw new ParseFault(j + 1);
  }
  if (open !== null) chunks.push(open);
  if (chunks.length === 0 && moveTo === null) throw new ParseFault(headAt + 1);
  return makeV4aUpdateEdit(path, moveTo, chunks, strict);
}

function makeV4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (tree.read(path) !== null) throw new EditFault('exists', path);
    tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    return null;
  };
}

function makeV4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (tree.read(path) === null) throw new EditFault('missing', path);
    tree.set(path, null);
    return null;
  };
}

function makeV4aUpdateEdit(
  path: string,
  moveTo: string | null,
  chunks: V4aChunk[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
    const before = tree.read(path);
    if (before === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.read(moveTo) !== null) throw new EditFault('exists', moveTo);
    const shape = splitFile(before);
    let fileLines = shape.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findAnchor(chunk.anchor, fileLines, cursor, strict);
        if (found < 0) throw new EditFault('no-match', path);
        cursor = found + 1;
      }
      const { oldLines, newParts } = splitBody(chunk.body);
      if (oldLines.length === 0) {
        const at = chunk.eof ? fileLines.length : cursor;
        const inserted = renderNew(newParts, oldLines, fileLines, at, 0);
        fileLines = fileLines.slice(0, at).concat(inserted, fileLines.slice(at));
        cursor = at + inserted.length;
      } else {
        const match = findLineMatch(oldLines, fileLines, strict, cursor, chunk.eof);
        if (match === null) throw new EditFault('no-match', path);
        const at = match.spots[0]!;
        const replacement = renderNew(newParts, oldLines, fileLines, at, match.tier);
        fileLines = fileLines
          .slice(0, at)
          .concat(replacement, fileLines.slice(at + oldLines.length));
        cursor = at + replacement.length;
      }
    }
    const after = joinFile(fileLines, shape.br, shape.final);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, after);
      return { from: path, to: moveTo };
    }
    tree.set(path, after);
    return null;
  };
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC sections 1, 2 and 10)
// ---------------------------------------------------------------------------

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

interface RunResult {
  code: number;
  out: string[];
}

function run(argv: string[]): RunResult {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const arg of argv) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const value = arg.slice('--format='.length);
        if (!FORMAT_NAMES.includes(value)) return { code: 2, out: ['error: usage'] };
        format = value;
      } else if (arg === '--check') {
        if (checkOnly) return { code: 2, out: ['error: usage'] };
        checkOnly = true;
      } else if (arg === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchArg = positional.length === 0 ? null : positional[0]!;
  const fromStdin = patchArg === null || patchArg === '-';
  let text = '';
  try {
    text = readFileSync(fromStdin ? 0 : patchArg, 'utf8');
  } catch {
    if (!fromStdin) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines, strict);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
  } catch (err) {
    if (err instanceof ParseFault) return { code: 2, out: [`error: parse ${err.lineNo}`] };
    throw err;
  }

  const tree = new WorkTree();
  const failures: EditFault[] = [];
  const moves: MoveRecord[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.pending);
    try {
      const moved = edit(tree);
      if (moved !== null) moves.push(moved);
    } catch (err) {
      if (!(err instanceof EditFault)) throw err;
      tree.pending.clear();
      for (const [key, value] of snapshot) tree.pending.set(key, value);
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }

  const rows = reportRows(tree, moves);
  if (!checkOnly) writeTree(tree);
  const okLine = `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`;
  return { code: 0, out: [...rows, okLine] };
}

/** The output rows for the paths whose state changed (SPEC section 2). */
function reportRows(tree: WorkTree, moves: MoveRecord[]): string[] {
  const rows: { key: string; text: string }[] = [];
  for (const path of tree.pending.keys()) {
    const was = tree.original(path);
    const now = tree.pending.get(path)!;
    if (was === now) continue;
    const text = was === null ? `A ${path}` : now === null ? `D ${path}` : `M ${path}`;
    rows.push({ key: path, text });
  }
  for (const move of moves) {
    const wasOld = tree.original(move.from);
    const nowOld = tree.read(move.from);
    const wasNew = tree.original(move.to);
    const nowNew = tree.read(move.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      const oldRow = rows.findIndex((r) => r.key === move.from && r.text.startsWith('D '));
      if (oldRow >= 0) rows.splice(oldRow, 1);
      const newRow = rows.findIndex((r) => r.key === move.to && r.text.startsWith('A '));
      if (newRow >= 0) rows.splice(newRow, 1);
      rows.push({ key: move.to, text: `R ${move.from} -> ${move.to}` });
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  return rows.map((r) => r.text);
}

/** Write every changed file, creating directories as files need them. */
function writeTree(tree: WorkTree): void {
  const paths = [...tree.pending.keys()].sort(byteOrder);
  for (const path of paths) {
    const was = tree.original(path);
    const now = tree.pending.get(path)!;
    if (was === now) continue;
    if (now === null) {
      rmSync(path, { force: true });
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, now);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((line) => `${line}\n`).join(''));
  process.exitCode = result.code;
}
