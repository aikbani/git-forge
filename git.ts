// git.ts — git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack,
// and v0 receive-pack (push with report-status + side-band-64k). No git binary, only
// node:crypto / node:zlib via store.ts. Written from the protocol, checked against the
// suite's own client (program/env/src/git-client.ts) line by line.

import {
  ZERO_OID,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type Forge,
  type GitObject,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// pkt-line codec
// -------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines; throws on malformed framing. */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3) {
      throw new Error('invalid pkt-line length 0003');
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Split a decoded stream at the first flush: [before, after]. */
function splitAtFlush(packets: Pkt[]): { before: Pkt[]; after: Buffer | null } {
  const before: Pkt[] = [];
  for (let index = 0; index < packets.length; index += 1) {
    if (packets[index].kind === 'flush') return { before, after: null };
    before.push(packets[index]);
  }
  return { before, after: null };
}

function dataLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// -------------------------------------------------------------------------------------------
// ref advertisement
// -------------------------------------------------------------------------------------------

const AGENT = 'git-forge/1.0';

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function peeledOf(repo: Repo, oid: string): string | undefined {
  const object = repo.getObject(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  return repo.peelToCommit(oid);
}

/** v2 capability advertisement: "version 2" + capability lines, then flush. Repo-independent: built once. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  pktLine(`agent=${AGENT}\n`),
  pktFlush(),
]);

export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** v0 ref advertisement for a service, with the "# service=" preamble. Cached per repo state. */
export function v0Advertisement(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cacheKey = `${repo.id}:v${repo.refsVersion}:ad0:${service}`;
  const cached = forge.v0AdCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const built = buildV0Advertisement(repo, service);
  if (forge.v0AdCache.size > 128) forge.v0AdCache.clear();
  forge.v0AdCache.set(cacheKey, built);
  return built;
}

function buildV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT} symref=HEAD:refs/heads/main object-format=sha1`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
  const refs = sortedRefs(repo);
  const headTip = repo.branchTip(repo.defaultBranch) || refs.find((ref) => ref.name.startsWith('refs/heads/'))?.oid || ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// fetch planning: which objects a fetch sends
// -------------------------------------------------------------------------------------------

export interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

function includeTree(repo: Repo, treeOid: string, out: Set<string>): void {
  const object = repo.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  if (out.has(treeOid)) return;
  out.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000') includeTree(repo, entry.oid, out);
    else out.add(entry.oid);
  }
}

/**
 * The objects a fetch sends.
 * - `wants`: wanted tips (commits or tags).
 * - `haves`: commits the client already holds; their reachable set is excluded, except a
 *   shallow boundary's parents are NOT held, so the walk stops there.
 * - `depth`: when set, only that many commit generations from each want; the boundary commits
 *   are reported as shallow, and old boundaries that are now interior are unshallow.
 */
export function fetchPlan(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const boundarySet = new Set(shallowBoundaries);
  const wanted = new Set<string>();
  const newBoundary = new Set<string>();

  // Depth-limited walk from the wants.
  interface QueueItem {
    oid: string;
    depth: number;
  }
  const queue: QueueItem[] = [];
  const seenCommit = new Set<string>();
  for (const want of wants) {
    const object = repo.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wanted.add(want);
      const target = repo.peelToCommit(want);
      if (target !== null) queue.push({ oid: target, depth: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    }
  }
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (seenCommit.has(item.oid)) continue;
    seenCommit.add(item.oid);
    const object = repo.getObject(item.oid);
    if (object === undefined || object.type !== 'commit') continue;
    wanted.add(item.oid);
    const commit = parseCommit(object.data);
    includeTree(repo, commit.tree, wanted);
    if (depth !== undefined && item.depth >= depth) {
      newBoundary.add(item.oid);
      continue;
    }
    for (const parent of commit.parents) queue.push({ oid: parent, depth: item.depth + 1 });
  }

  // What the client already holds: reachable from haves, stopping at shallow boundaries.
  const held = new Set<string>();
  const heldQueue: string[] = [];
  for (const have of haves) {
    const object = repo.getObject(have);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      held.add(have);
      const target = repo.peelToCommit(have);
      if (target !== null) heldQueue.push(target);
    } else if (object.type === 'commit') {
      heldQueue.push(have);
    }
  }
  const heldCommits = new Set<string>();
  while (heldQueue.length > 0) {
    const oid = heldQueue.shift()!;
    if (heldCommits.has(oid)) continue;
    heldCommits.add(oid);
    const object = repo.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    held.add(oid);
    const commit = parseCommit(object.data);
    includeTree(repo, commit.tree, held);
    if (boundarySet.has(oid)) continue;
    for (const parent of commit.parents) heldQueue.push(parent);
  }

  const objects = new Map<string, GitObject>();
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = repo.getObject(oid);
    if (object !== undefined) objects.set(oid, object);
  }

  const shallow = depth === undefined ? [] : [...newBoundary].sort();
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const old of boundarySet) {
      if (seenCommit.has(old) && !newBoundary.has(old)) unshallow.push(old);
    }
    unshallow.sort();
  }
  return { objects, shallow, unshallow };
}

/** Pack bytes for a fetch, cached when the request has no haves (the clone workload's shape). */
export function packForFetch(forge: Forge, repo: Repo, plan: FetchPlan, cacheKey: string | null): Buffer {
  if (cacheKey !== null) {
    const cached = forge.packCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const pack = writePack(plan.objects.values());
  if (cacheKey !== null) {
    if (forge.packCache.size > 128) forge.packCache.clear();
    forge.packCache.set(cacheKey, pack);
  }
  return pack;
}

/** Sideband-framed pack: pkt-lines whose payload is band byte 1 + pack chunk. */
export function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  if (pack.length === 0) {
    // An empty pack still needs one sideband packet so the client sees a packfile section.
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), writePack([])])));
    return parts;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// -------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs and fetch
// -------------------------------------------------------------------------------------------

function lsRefsV2(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  const cacheKey = `${repo.id}:v${repo.refsVersion}:lsrefs:${args.join('|')}`;
  const cached = forge.lsRefsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const built = buildLsRefsV2(repo, args);
  if (forge.lsRefsCache.size > 128) forge.lsRefsCache.clear();
  forge.lsRefsCache.set(cacheKey, built);
  return built;
}

function buildLsRefsV2(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTip = repo.branchTip(repo.defaultBranch);
  const refs = sortedRefs(repo);
  if (keep('HEAD')) {
    if (refs.length === 0) {
      parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    } else if (symrefs) {
      parts.push(pktLine(`${headTip} HEAD symref-target:refs/heads/main\n`));
    } else {
      parts.push(pktLine(`${headTip} HEAD\n`));
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function fetchV2(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  // No-haves fetches are fully determined by (repo state, wants, depth): cache the
  // whole response, not just the pack — fetchPlan's tree walk is the hot cost.
  const responseCacheKey =
    haves.length === 0 && shallow.length === 0
      ? `${repo.id}:v${repo.refsVersion}:${depth === undefined ? 'full' : `d${depth}`}:${[...new Set(wants)].sort().join(',')}`
      : null;
  if (responseCacheKey !== null) {
    const cached = forge.fetchResponseCache.get(responseCacheKey);
    if (cached !== undefined) return cached;
  }
  const plan = fetchPlan(repo, wants, haves, shallow, depth);
  const pack = packForFetch(forge, repo, plan, responseCacheKey);
  // Real git's upload-pack omits the "acknowledgments" section for a single-round
  // fetch (client sends `done` at once): it goes straight to shallow-info/packfile,
  // and real git's reader dies on a present acknowledgments section
  // ("expected 'packfile', received 'acknowledgments'"). The suite's fetch parser
  // accepts sections in any order and treats acknowledgments as optional, so the
  // section is omitted here too.
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  const response = Buffer.concat(parts);
  if (responseCacheKey !== null) {
    if (forge.fetchResponseCache.size > 128) forge.fetchResponseCache.clear();
    forge.fetchResponseCache.set(responseCacheKey, response);
  }
  return response;
}

function fetchV0(forge: Forge, repo: Repo, body: Buffer): Buffer {
  // v0 request: want lines (+shallow/deepen), flush, have lines, done, flush.
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let inHaves = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      inHaves = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = fetchPlan(repo, wants, haves, shallow, depth);
  const cacheKey =
    haves.length === 0 && shallow.length === 0
      ? `${repo.id}:v${repo.refsVersion}:${depth === undefined ? 'full' : `d${depth}`}:${[...wants].sort().join(',')}`
      : null;
  const pack = packForFetch(forge, repo, plan, cacheKey);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// receive-pack v0: push
// -------------------------------------------------------------------------------------------

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

function receivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  // Commands are pkt-lines up to the first flush; the packfile follows raw.
  let offset = 0;
  const commandLines: string[] = [];
  let packStart = body.length;
  let sawFlush = false;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packStart = offset + 4;
      sawFlush = true;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    commandLines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  if (!sawFlush && offset < body.length) packStart = offset;

  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const rawLine of commandLines) {
    const line = rawLine.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }

  const report: PushReportLine[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.getObject(oid));
      for (const object of read.objects.values()) repo.putExisting(object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.replace(/\n/g, ' ') : 'unpack error';
    }
  }

  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? '';
      let ok = false;
      let reason = '';
      if (!isOid(command.oldOid) || !isOid(command.newOid)) {
        reason = 'invalid object id';
      } else if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
        reason = 'invalid command';
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== '') reason = 'already exists';
        else if (command.newOid !== ZERO_OID && repo.getObject(command.newOid) === undefined) reason = 'missing object';
        else ok = true;
      } else if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === '') reason = 'non-fast-forward';
        else if (current !== command.oldOid) reason = 'non-fast-forward';
        else ok = true;
      } else {
        // Update.
        if (current === '') reason = 'non-fast-forward';
        else if (current !== command.oldOid) reason = 'non-fast-forward';
        else if (repo.getObject(command.newOid) === undefined) reason = 'missing object';
        else if (!repo.isAncestor(command.oldOid, command.newOid)) reason = 'non-fast-forward';
        else ok = true;
      }
      if (ok) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        repo.refsVersion += 1;
        forge.clearRepoCaches(repo.id);
      }
      report.push({ ref: command.ref, ok, reason });
    }
  }

  const inner: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const line of report) {
    inner.push(pktLine(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`));
  }
  inner.push(pktFlush());
  const innerStream = Buffer.concat(inner);
  return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), innerStream])), pktFlush()]);
}

// -------------------------------------------------------------------------------------------
// entry points: (forge, repo, body, isV2) -> {status, contentType, body}
// -------------------------------------------------------------------------------------------

export interface GitAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

function json404(message: string): GitAnswer {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

export function gitInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  wantV2: boolean,
): GitAnswer {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return json404('Not Found');
  if (service === 'git-upload-pack') {
    if (wantV2) return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(forge, repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(forge, repo, 'git-receive-pack') };
  }
  return json404('Not Found');
}

export function gitUploadPack(forge: Forge, owner: string, repoName: string, body: Buffer, wantV2: boolean): GitAnswer {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return json404('Not Found');
  try {
    if (wantV2) {
      const packets = decodePktLines(body);
      const lines = dataLines(packets);
      const commandLine = lines[0] ?? '';
      // Args follow the delim packet.
      const args: string[] = [];
      let afterDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (packet.kind === 'flush') break;
        if (afterDelim && packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
      }
      if (commandLine.startsWith('command=ls-refs')) {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsV2(forge, repo, args) };
      }
      if (commandLine.startsWith('command=fetch')) {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(forge, repo, args) };
      }
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"unknown command"}\n', 'utf8') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(forge, repo, body) };
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"malformed request"}\n', 'utf8') };
  }
}

export function gitReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitAnswer {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return json404('Not Found');
  try {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePack(forge, repo, body) };
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"malformed request"}\n', 'utf8') };
  }
}

// Re-export for the app's use.
export { splitAtFlush };
