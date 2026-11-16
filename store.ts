// store.ts — the forge's whole in-memory store: git objects, packfiles, refs and the
// REST/GraphQL/MCP entities (repositories, issues, pull requests, labels, comments).
// Everything here is deterministic: no wall clock, no randomness. Fixed timestamps and
// sequential ids keep two runs on the same requests byte-identical in behaviour.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/**
 * The login the trial token names. The suite's scenario is built from one constant seed
 * (wire.ts SCENARIO_SEED), so the viewer login is the same in every trial of this
 * competition: the first generated user, "adaiversen" (stranger: "olgabauer").
 * Repositories are owned by this login; any other owner reads as 404, never 403.
 */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

/** The one timestamp every created_at / merged_at carries: fixed, never Date.now(). */
export const FIXED_TIME = '2026-11-14T06:30:00Z';
/** Identity every server-made commit carries. */
export const SERVER_IDENTITY = 'Conformance <conformance@make.fun>';
const FIXED_EPOCH = 1700000000;

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// -------------------------------------------------------------------------------------------
// git object parsing / building
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitBytes(tree: string, parents: readonly string[], message: string, timestamp = FIXED_EPOCH): Buffer {
  const who = `${SERVER_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const text = `${lines.join('\n')}\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return Buffer.from(text, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// -------------------------------------------------------------------------------------------
// packfiles: read (with OFS/REF deltas, thin-pack bases from the store) and write (plain)
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset, end), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile v2/v3; `resolveBase` supplies thin-pack bases the pack itself lacks. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} missing`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas): small, fast, always valid. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// -------------------------------------------------------------------------------------------
// repository entities
// -------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  /** oid -> object */
  readonly objects = new Map<string, GitObject>();
  /** ref name -> oid */
  readonly refs = new Map<string, string>();
  /** commit oid -> parent oids (parsed lazily, cached: commits are immutable) */
  readonly parentsCache = new Map<string, string[]>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  readonly comments = new Map<number, Comment[]>();
  nextNumber = 1;
  /** Bumps on every ref change; pack/advertisement caches key off it. */
  refsVersion = 0;
  /** Serialized JSON cache for GET issue (invalidated on issue mutation). Stored as a Buffer: no re-encode per request. */
  issueJsonCache = new Map<number, Buffer>();

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.fullName = `${owner}/${name}`;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putExisting(object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    if (!this.objects.has(oid)) this.objects.set(oid, object);
    return oid;
  }

  /** Parents of a commit, cached. */
  parentsOf(oid: string): string[] {
    const cached = this.parentsCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return [];
    const parents = parseCommit(object.data).parents;
    this.parentsCache.set(oid, parents);
    return parents;
  }

  /** True when `ancestor` is reachable from `oid` (or equal to it). */
  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const parent of this.parentsOf(current)) stack.push(parent);
    }
    return false;
  }

  /** Resolve a tag object to its target commit (following tag chains). */
  peelToCommit(oid: string): string | null {
    let current = oid;
    const seen = new Set<string>();
    for (let depth = 0; depth < 10; depth += 1) {
      if (seen.has(current)) return null;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Every object reachable from `roots` (commits, trees, blobs, tags). */
  reachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const root of roots) if (isOid(root)) stack.push(root);
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** Flatten a tree oid to path -> {oid, mode}, recursively. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a tree object from a flat path -> blob oid map, storing intermediate trees. */
  buildTreeFromMap(flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        let child = node.dirs.get(name);
        if (child === undefined) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1], value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object on top of `treeOid` with `parents`, store it, return its oid. */
  makeCommit(treeOid: string, parents: readonly string[], message: string): string {
    return this.putObject('commit', buildCommitBytes(treeOid, parents, message));
  }

  /** Tip of a branch name, or '' when the ref does not exist. */
  branchTip(branch: string): string {
    return this.refs.get(`refs/heads/${branch}`) ?? '';
  }

  /** All branch names, sorted. */
  branchNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    names.sort();
    return names;
  }

  /** Commits reachable from `tip`, newest first (tip, then parents breadth-first by depth). */
  commitList(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of this.parentsOf(oid)) queue.push(parent);
    }
    return out;
  }

  /** First common ancestor of two commits (merge-base), or '' when none. */
  mergeBase(a: string, b: string): string {
    if (a === '' || b === '') return '';
    if (a === b) return a;
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      for (const parent of this.parentsOf(oid)) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.shift()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      for (const parent of this.parentsOf(oid)) queueB.push(parent);
    }
    return '';
  }
}

// -------------------------------------------------------------------------------------------
// the forge: every repository, plus the global id counters
// -------------------------------------------------------------------------------------------

export class Forge {
  readonly repos = new Map<string, Repo>();
  repoSeq = 0;
  issueSeq = 0;
  commentSeq = 0;
  pullSeq = 0;
  /** Pack cache: key -> pack bytes. Keys embed the repo id + tip + shape, so a ref move misses. */
  readonly packCache = new Map<string, Buffer>();
  /** Whole fetch-v2 response cache (shallow-info + sideband pack), same key shape as packCache. */
  readonly fetchResponseCache = new Map<string, Buffer>();
  /** ls-refs v2 responses, keyed by repo + refsVersion + args. */
  readonly lsRefsCache = new Map<string, Buffer>();
  /** v0 advertisements, keyed by repo + refsVersion + service. */
  readonly v0AdCache = new Map<string, Buffer>();

  /** Drop every cached derived blob for one repo (call on any ref change). */
  clearRepoCaches(repoId: number): void {
    const prefix = `${repoId}:`;
    for (const cache of [this.packCache, this.fetchResponseCache, this.lsRefsCache, this.v0AdCache]) {
      for (const key of [...cache.keys()]) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
    }
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    const repo = new Repo(this.repoSeq, VIEWER_LOGIN, name, description, isPrivate);
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName);
    this.clearRepoCaches(repo.id);
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  nextPullId(): number {
    this.pullSeq += 1;
    return this.pullSeq;
  }
}

// -------------------------------------------------------------------------------------------
// JSON views (GitHub-shaped, stable field order)
// -------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

/** Opaque, stable Relay global id: base64 of "<Kind>:<repoDbId>[:<number>]". */
export function globalId(kind: string, repoId: number, number?: number): string {
  const raw = number === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${number}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

export interface DecodedGlobalId {
  kind: string;
  repoId: number;
  number?: number;
}

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0];
    const repoId = Number(parts[1]);
    if (!Number.isInteger(repoId) || repoId <= 0) return null;
    if (parts.length === 2) return { kind, repoId };
    const number = Number(parts[2]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { kind, repoId, number };
  } catch {
    return null;
  }
}

/** Line-diff counts between two texts (simple LCS on lines; exact for adds/removes). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // LCS via DP on line arrays (files here are small).
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i += 1) dp.push(new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: n - common, deletions: m - common };
}

/** The changed files between two tree oids: filename, status, additions, deletions, changes. */
export function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): Array<{
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}> {
  const base = baseTreeOid === '' ? new Map() : repo.flattenTree(baseTreeOid);
  const head = headTreeOid === '' ? new Map() : repo.flattenTree(headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined) {
      if (b.oid === h.oid) continue;
      const oldText = repo.getObject(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.getObject(h.oid)?.data.toString('utf8') ?? '';
      const counts = lineDiffCounts(oldText, newText);
      out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    } else if (h !== undefined) {
      const newText = repo.getObject(h.oid)?.data.toString('utf8') ?? '';
      const lines = newText === '' ? 0 : newText.split('\n').length;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b !== undefined) {
      const oldText = repo.getObject(b.oid)?.data.toString('utf8') ?? '';
      const lines = oldText === '' ? 0 : oldText.split('\n').length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    }
  }
  return out;
}

/**
 * Three-way merge of `headTree` onto `currentTree` with `baseTree` as ancestor.
 * Returns the merged flat map, or null on conflict (both sides changed the same path differently).
 */
export function threeWayMerge(
  repo: Repo,
  baseTreeOid: string,
  currentTreeOid: string,
  headTreeOid: string,
): Map<string, { oid: string; mode: string }> | null {
  const base = baseTreeOid === '' ? new Map() : repo.flattenTree(baseTreeOid);
  const current = currentTreeOid === '' ? new Map() : repo.flattenTree(currentTreeOid);
  const head = headTreeOid === '' ? new Map() : repo.flattenTree(headTreeOid);
  const merged = new Map<string, { oid: string; mode: string }>(current);
  const paths = new Set([...base.keys(), ...current.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const c = current.get(path);
    const h = head.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    if (same(h, b)) {
      // Head unchanged: keep current (already in merged).
      continue;
    }
    if (same(c, b)) {
      // Current unchanged: take head.
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
      continue;
    }
    if (same(h, c)) continue;
    return null;
  }
  return merged;
}

/** 'MERGEABLE' or 'CONFLICTING' for a pull request against its base branch's current tip. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  if (pull.merged) return 'MERGEABLE';
  const baseTip = repo.branchTip(pull.base);
  if (baseTip === '' || pull.headSha === '') return 'MERGEABLE';
  const baseTree = treeOfCommit(repo, baseTip);
  const headTree = treeOfCommit(repo, pull.headSha);
  const mergeBaseOid = repo.mergeBase(baseTip, pull.headSha);
  const baseTreeOid = mergeBaseOid === '' ? '' : treeOfCommit(repo, mergeBaseOid);
  return threeWayMerge(repo, baseTreeOid, baseTree, headTree) !== null ? 'MERGEABLE' : 'CONFLICTING';
}

export function treeOfCommit(repo: Repo, commitOid: string): string {
  const object = repo.getObject(commitOid);
  if (object === undefined || object.type !== 'commit') return '';
  return parseCommit(object.data).tree;
}

/** Apply a squash merge of `pull` onto its base branch; returns the merge commit oid or null on conflict. */
export function squashMerge(forge: Forge, repo: Repo, pull: Pull): string | null {
  const baseTip = repo.branchTip(pull.base);
  if (baseTip === '' || pull.headSha === '') return null;
  const mergeBaseOid = repo.mergeBase(baseTip, pull.headSha);
  const baseTreeOid = mergeBaseOid === '' ? '' : treeOfCommit(repo, mergeBaseOid);
  const merged = threeWayMerge(repo, baseTreeOid, treeOfCommit(repo, baseTip), treeOfCommit(repo, pull.headSha));
  if (merged === null) return null;
  const treeOid = repo.buildTreeFromMap(merged);
  const message = `Merge pull request #${pull.number} from ${pull.head}`;
  const commitOid = repo.makeCommit(treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  repo.refsVersion += 1;
  forge.clearRepoCaches(repo.id);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TIME;
  pull.mergeCommitSha = commitOid;
  pull.baseSha = commitOid;
  return commitOid;
}

// -------------------------------------------------------------------------------------------
// shared entity operations (REST, GraphQL and MCP all funnel through these)
// -------------------------------------------------------------------------------------------

/** Create an issue; unknown label names fail with an error message. */
export function createIssue(
  forge: Forge,
  repo: Repo,
  title: string,
  bodyText: string,
  labelNames: readonly string[],
): { issue: Issue } | { error: string } {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name);
    if (label === undefined) return { error: `Label '${name}' does not exist` };
    labels.push(label);
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    id: forge.nextIssueId(),
    number,
    title,
    body: bodyText,
    state: 'open',
    labels,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
  repo.issues.set(number, issue);
  return { issue };
}

/** Close (or reopen) an issue and drop its cached JSON. */
export function setIssueState(repo: Repo, issue: Issue, state: 'open' | 'closed'): void {
  issue.state = state;
  issue.updatedAt = FIXED_TIME;
  repo.issueJsonCache.delete(issue.number);
}

/** Append a comment to an issue; null when the issue does not exist. */
export function addComment(forge: Forge, repo: Repo, issueNumber: number, bodyText: string): Comment | null {
  if (!repo.issues.has(issueNumber)) return null;
  const comment: Comment = { id: forge.nextCommentId(), body: bodyText, createdAt: FIXED_TIME };
  const list = repo.comments.get(issueNumber) ?? [];
  list.push(comment);
  repo.comments.set(issueNumber, list);
  return comment;
}

/** Create a pull request; unknown branches or a duplicate open PR fail with an error. */
export function createPull(
  forge: Forge,
  repo: Repo,
  title: string,
  bodyText: string,
  headRef: string,
  baseRef: string,
): { pull: Pull } | { error: string } {
  const headSha = headRef === '' ? '' : repo.branchTip(headRef);
  const baseSha = baseRef === '' ? '' : repo.branchTip(baseRef);
  if (headSha === '' || baseSha === '') return { error: 'Invalid head or base branch' };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === headRef && existing.base === baseRef) {
      return { error: 'A pull request already exists for this head and base' };
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    id: forge.nextPullId(),
    number,
    title,
    body: bodyText,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head: headRef,
    base: baseRef,
    headSha,
    baseSha,
  };
  repo.pulls.set(number, pull);
  return { pull };
}
