// app.ts — the forge's HTTP server: routing, the REST v3 surface, and dispatch to the
// git smart-HTTP, GraphQL and MCP modules. Node stdlib only (node:http).
//
// Hot paths (the timed workloads) are kept lean: the issue read serves a cached JSON
// string, the issue write builds one object and serializes it once, and routing avoids
// `new URL` per request.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  FIXED_TIME,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  createIssue,
  createPull,
  diffTrees,
  issueJson,
  parseCommit,
  parseTree,
  pullJson,
  repoJson,
  setIssueState,
  squashMerge,
  treeOfCommit,
  type Forge,
  type Issue,
  type Repo,
} from './store.ts';
import { Forge as ForgeClass } from './store.ts';
import { gitInfoRefs, gitReceivePack, gitUploadPack } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT = (s: string): Buffer => Buffer.from(s, 'utf8');
/** Shared empty query params for requests without a query string. */
const EMPTY_QUERY = new URLSearchParams('');

function makeForge(): Forge {
  return new ForgeClass();
}

export function createApp(): Server {
  const forge = makeForge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const text = `${JSON.stringify(body)}\n`;
    const headers: Record<string, string> = {
      'content-type': JSON_TYPE,
      'x-github-request-id': `req-${(requestCounter += 1)}`,
      ...extra,
    };
    if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
    res.writeHead(status, headers);
    res.end(status === 204 ? undefined : text);
  };

  const sendRaw = (res: ServerResponse, status: number, contentType: string, body: Buffer): void => {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(body.length),
      'x-github-request-id': `req-${(requestCounter += 1)}`,
    });
    res.end(body);
  };

  const err = (res: ServerResponse, status: number, message: string): void => {
    sendJson(res, status, { message });
  };

  const authed = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice('Bearer '.length);
    if (token === '') return false;
    if (expectedToken !== '') return token === expectedToken;
    return true;
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  /** Parse a request body as JSON: null when empty, throws on malformed JSON. */
  const parseBody = (body: Buffer): Record<string, unknown> | null => {
    if (body.length === 0) return null;
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  };

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        await handle(req, res);
      } catch (e) {
        if (!res.writableEnded) {
          try {
            err(res, 500, e instanceof Error ? e.message : 'internal error');
          } catch {
            // The socket is gone; nothing more to do.
          }
        }
      }
    })();
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const queryIndex = rawUrl.indexOf('?');
    const rawPath = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
    const queryString = queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : '';
    // Hot paths carry no query string: skip URLSearchParams construction then.
    const query = queryString === '' ? EMPTY_QUERY : new URLSearchParams(queryString);
    const path = rawPath.includes('%') ? decodeURIComponent(rawPath) : rawPath;

    // The env's boot probe: no auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
    if (gitMatch !== null) {
      const owner = gitMatch[1];
      const repoName = gitMatch[2];
      const suffix = gitMatch[3];
      if (method === 'GET' && suffix === 'info/refs') {
        const service = query.get('service') ?? '';
        const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const answer = gitInfoRefs(forge, owner, repoName, service, wantV2);
        sendRaw(res, answer.status, answer.contentType, answer.body);
        return;
      }
      if (method === 'POST' && suffix === 'git-upload-pack') {
        const body = await readBody(req);
        const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const answer = gitUploadPack(forge, owner, repoName, body, wantV2);
        sendRaw(res, answer.status, answer.contentType, answer.body);
        return;
      }
      if (method === 'POST' && suffix === 'git-receive-pack') {
        const body = await readBody(req);
        const answer = gitReceivePack(forge, owner, repoName, body);
        sendRaw(res, answer.status, answer.contentType, answer.body);
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // GraphQL v4.
    if (path === '/api/graphql') {
      if (method !== 'POST') {
        err(res, 404, 'Not Found');
        return;
      }
      if (!authed(req)) {
        err(res, 401, 'Requires authentication');
        return;
      }
      const body = await readBody(req);
      const answer = handleGraphQL(forge, body);
      sendRaw(res, answer.status, answer.contentType, answer.body);
      return;
    }

    // MCP.
    if (path === '/mcp') {
      if (method === 'DELETE') {
        res.writeHead(204, { 'x-github-request-id': `req-${(requestCounter += 1)}` });
        res.end();
        return;
      }
      if (method !== 'POST') {
        err(res, 404, 'Not Found');
        return;
      }
      if (!authed(req)) {
        err(res, 401, 'Requires authentication');
        return;
      }
      const body = await readBody(req);
      const answer = handleMcp(forge, body);
      sendRaw(res, answer.status, answer.contentType, answer.body);
      return;
    }

    // Fast path (the read workload): GET /api/v3/repos/{owner}/{repo}/issues/{n}.
    // Skips the generic router's segment splitting; identical responses + headers.
    if (method === 'GET' && path.startsWith('/api/v3/repos/')) {
      const fast = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)$/.exec(path);
      if (fast !== null) {
        if (!authed(req)) {
          err(res, 401, 'Requires authentication');
          return;
        }
        const fastRepo = fast[1] === VIEWER_LOGIN ? forge.getRepo(fast[1], fast[2]) : undefined;
        if (fastRepo === undefined) {
          err(res, 404, 'Not Found');
          return;
        }
        const fastNumber = Number(fast[3]);
        const fastIssue = fastRepo.issues.get(fastNumber);
        if (fastIssue === undefined) {
          err(res, 404, 'Not Found');
          return;
        }
        const cached = fastRepo.issueJsonCache.get(fastNumber);
        if (cached !== undefined) {
          res.writeHead(200, {
            'content-type': JSON_TYPE,
            'content-length': String(cached.length),
            'x-github-request-id': `req-${(requestCounter += 1)}`,
          });
          res.end(cached);
          return;
        }
        const buf = Buffer.from(`${JSON.stringify(issueJson(fastRepo, fastIssue))}\n`, 'utf8');
        fastRepo.issueJsonCache.set(fastNumber, buf);
        res.writeHead(200, {
          'content-type': JSON_TYPE,
          'content-length': String(buf.length),
          'x-github-request-id': `req-${(requestCounter += 1)}`,
        });
        res.end(buf);
        return;
      }
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!authed(req)) {
        err(res, 401, 'Requires authentication');
        return;
      }
      const hasBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
      let body: Buffer = Buffer.alloc(0);
      let parsed: Record<string, unknown> | null = null;
      if (hasBody) {
        body = await readBody(req);
        if (body.length > 0) {
          try {
            parsed = parseBody(body);
          } catch {
            err(res, 400, 'Problems parsing JSON');
            return;
          }
        }
      }
      await handleRest(req, res, method, path, query, parsed);
      return;
    }

    err(res, 404, 'Not Found');
  }

  // -----------------------------------------------------------------------------------------
  // REST v3
  // -----------------------------------------------------------------------------------------

  function repoOf(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return forge.getRepo(owner, name);
  }

  function commitMessageOf(repo: Repo, oid: string): string {
    const object = repo.getObject(oid);
    if (object === undefined || object.type !== 'commit') return '';
    const message = parseCommit(object.data).message;
    return message.endsWith('\n') ? message.slice(0, -1) : message;
  }

  async function handleRest(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown> | null,
  ): Promise<void> {
    const segments = path.split('/').filter((s) => s !== '');
    // segments[0] === 'api', segments[1] === 'v3'
    const rest = segments.slice(2);

    // GET /api/v3/ — the API root.
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, user' });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // GET /api/v3/meta
    if (rest.length === 1 && rest[0] === 'meta') {
      if (method === 'GET') {
        sendJson(res, 200, { installed_version: '1.0.0' });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // GET /api/v3/user
    if (rest.length === 1 && rest[0] === 'user') {
      if (method === 'GET') {
        sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /api/v3/user/repos
    if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
      if (method === 'GET') {
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
        const all = forge.listViewerRepos();
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const extra: Record<string, string> = {};
        if (page * perPage < all.length) {
          const host = req.headers.host ?? '127.0.0.1';
          extra.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
        }
        sendJson(res, 200, slice.map((repo) => repoJson(repo)), extra);
        return;
      }
      if (method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name : '';
        if (name === '') {
          err(res, 422, 'name is required');
          return;
        }
        if (forge.getRepo(VIEWER_LOGIN, name) !== undefined) {
          err(res, 422, 'name already exists on this account');
          return;
        }
        const description = typeof body?.description === 'string' ? body.description : '';
        const isPrivate = body?.private === true;
        const repo = forge.createRepo(name, description, isPrivate);
        sendJson(res, 201, repoJson(repo));
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /api/v3/repos/{owner}/{repo}[...]
    if (rest.length >= 3 && rest[0] === 'repos') {
      const owner = rest[1];
      const name = rest[2];
      const repo = repoOf(owner, name);
      if (repo === undefined) {
        err(res, 404, 'Not Found');
        return;
      }
      const tail = rest.slice(3);
      await handleRepoRoute(req, res, method, repo, tail, query, body);
      return;
    }

    err(res, 404, 'Not Found');
  }

  async function handleRepoRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    repo: Repo,
    tail: string[],
    query: URLSearchParams,
    body: Record<string, unknown> | null,
  ): Promise<void> {
    // /repos/{o}/{r} itself.
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body?.description === 'string') repo.description = body.description;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo);
        res.writeHead(204, { 'x-github-request-id': `req-${(requestCounter += 1)}`, 'content-type': JSON_TYPE });
        res.end();
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    const head = tail[0];

    // GET /branches, GET /branches/{branch}
    if (head === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const list = repo.branchNames().map((name) => ({
          name,
          commit: { sha: repo.branchTip(name) },
          protected: false,
        }));
        sendJson(res, 200, list);
        return;
      }
      if (method === 'GET' && tail.length === 2) {
        const tip = repo.branchTip(tail[1]);
        if (tip === '') {
          err(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { name: tail[1], commit: { sha: tip }, protected: false });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // GET /git/refs/heads/{branch}, POST /git/refs
    if (head === 'git' && tail[1] === 'refs') {
      if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
        const tip = repo.branchTip(tail[3]);
        if (tip === '') {
          err(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref: `refs/heads/${tail[3]}`, object: { sha: tip, type: 'commit' } });
        return;
      }
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof body?.ref === 'string' ? body.ref : '';
        const sha = typeof body?.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || sha === '') {
          err(res, 422, 'Invalid ref or sha');
          return;
        }
        if (repo.refs.has(ref)) {
          err(res, 422, 'Reference already exists');
          return;
        }
        const object = repo.getObject(sha);
        if (object === undefined || object.type !== 'commit') {
          err(res, 422, 'Invalid sha');
          return;
        }
        repo.refs.set(ref, sha);
        repo.refsVersion += 1;
        forge.clearRepoCaches(repo.id);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // GET /commits[?sha=]
    if (head === 'commits') {
      if (method === 'GET' && tail.length === 1) {
        const refParam = query.get('sha') ?? '';
        let tip = '';
        if (refParam === '') tip = repo.branchTip(repo.defaultBranch);
        else if (repo.refs.has(`refs/heads/${refParam}`)) tip = repo.branchTip(refParam);
        else if (repo.getObject(refParam)?.type === 'commit') tip = refParam;
        if (tip === '') {
          sendJson(res, 200, []);
          return;
        }
        const list = repo.commitList(tip).map((sha) => ({
          sha,
          commit: {
            message: commitMessageOf(repo, sha),
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
          },
        }));
        sendJson(res, 200, list);
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /contents/{path...}
    if (head === 'contents') {
      const contentPath = tail.slice(1).join('/');
      if (method === 'GET') {
        const refParam = query.get('ref') ?? '';
        let tip = '';
        if (refParam === '') tip = repo.branchTip(repo.defaultBranch);
        else if (repo.refs.has(`refs/heads/${refParam}`)) tip = repo.branchTip(refParam);
        else if (repo.getObject(refParam)?.type === 'commit') tip = refParam;
        if (tip === '') {
          err(res, 404, 'Not Found');
          return;
        }
        const treeOid = treeOfCommit(repo, tip);
        const answer = readContentPath(repo, treeOid, contentPath);
        if (answer === null) {
          err(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, answer);
        return;
      }
      if (method === 'PUT') {
        const message = typeof body?.message === 'string' ? body.message : `Update ${contentPath}`;
        const contentB64 = typeof body?.content === 'string' ? body.content : '';
        let contentBytes: Buffer;
        try {
          contentBytes = Buffer.from(contentB64, 'base64');
        } catch {
          err(res, 422, 'Invalid content');
          return;
        }
        const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        let tip = repo.branchTip(branch);
        if (tip === '' && !repo.refs.has(`refs/heads/${branch}`)) {
          // Create the branch at the default branch tip (or unborn when the repo is empty).
          const baseTip = repo.branchTip(repo.defaultBranch);
          if (baseTip !== '') {
            repo.refs.set(`refs/heads/${branch}`, baseTip);
            tip = baseTip;
          }
        }
        const flat = tip === '' ? new Map<string, { oid: string; mode: string }>() : repo.flattenTree(treeOfCommit(repo, tip));
        const existing = flat.get(contentPath);
        const blobOid = repo.putObject('blob', contentBytes);
        let status = 201;
        if (existing !== undefined) {
          const givenSha = typeof body?.sha === 'string' ? body.sha : '';
          if (givenSha !== '' && givenSha !== existing.oid) {
            err(res, 409, 'sha does not match the current blob');
            return;
          }
          status = 200;
        }
        flat.set(contentPath, { oid: blobOid, mode: '100644' });
        const treeOid = repo.buildTreeFromMap(flat);
        const commitOid = repo.makeCommit(treeOid, tip === '' ? [] : [tip], message);
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        repo.refsVersion += 1;
        forge.clearRepoCaches(repo.id);
        const baseName = contentPath.split('/').pop() ?? contentPath;
        sendJson(res, status, {
          content: { name: baseName, path: contentPath, sha: blobOid, size: contentBytes.length, type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: commitOid, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const tip = repo.branchTip(branch);
        if (tip === '') {
          err(res, 404, 'Not Found');
          return;
        }
        const flat = repo.flattenTree(treeOfCommit(repo, tip));
        if (!flat.has(contentPath)) {
          err(res, 404, 'Not Found');
          return;
        }
        const message = typeof body?.message === 'string' ? body.message : `Delete ${contentPath}`;
        flat.delete(contentPath);
        const treeOid = repo.buildTreeFromMap(flat);
        const commitOid = repo.makeCommit(treeOid, [tip], message);
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        repo.refsVersion += 1;
        forge.clearRepoCaches(repo.id);
        sendJson(res, 200, { commit: { sha: commitOid, message } });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /labels
    if (head === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
        return;
      }
      if (method === 'POST' && tail.length === 1) {
        const name = typeof body?.name === 'string' ? body.name : '';
        if (name === '') {
          err(res, 422, 'name is required');
          return;
        }
        const existing = repo.labels.get(name);
        if (existing !== undefined) {
          sendJson(res, 201, { name: existing.name, color: existing.color, description: existing.description });
          return;
        }
        const color = typeof body?.color === 'string' ? body.color : 'ededed';
        const description = typeof body?.description === 'string' ? body.description : '';
        const label = { name, color, description };
        repo.labels.set(name, label);
        sendJson(res, 201, { name, color, description });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /issues[/{n}[/comments]]
    if (head === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
          const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          const slice = list.slice((page - 1) * perPage, page * perPage);
          sendJson(res, 200, slice.map((issue) => issueJson(repo, issue)));
          return;
        }
        if (method === 'POST') {
          const title = typeof body?.title === 'string' ? body.title : '';
          const bodyText = typeof body?.body === 'string' ? body.body : '';
          const labelNames = Array.isArray(body?.labels) ? (body.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          const created = createIssue(forge, repo, title, bodyText, labelNames);
          if ('error' in created) {
            err(res, 422, created.error);
            return;
          }
          sendJson(res, 201, issueJson(repo, created.issue));
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number <= 0) {
        err(res, 404, 'Not Found');
        return;
      }
      const issue = repo.issues.get(number);
      if (tail.length === 2) {
        if (issue === undefined) {
          err(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          // Hot path (the read workload): serve the cached serialization.
          const cached = repo.issueJsonCache.get(number);
          if (cached !== undefined) {
            res.writeHead(200, {
              'content-type': JSON_TYPE,
              'content-length': String(cached.length),
              'x-github-request-id': `req-${(requestCounter += 1)}`,
            });
            res.end(cached);
            return;
          }
          const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
          const buf = Buffer.from(text, 'utf8');
          repo.issueJsonCache.set(number, buf);
          res.writeHead(200, {
            'content-type': JSON_TYPE,
            'content-length': String(buf.length),
            'x-github-request-id': `req-${(requestCounter += 1)}`,
          });
          res.end(buf);
          return;
        }
        if (method === 'PATCH') {
          if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) setIssueState(repo, issue, body.state);
          if (typeof body?.title === 'string') issue.title = body.title;
          if (typeof body?.body === 'string') issue.body = body.body;
          issue.updatedAt = FIXED_TIME;
          repo.issueJsonCache.delete(number);
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) {
          err(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          const list = (repo.comments.get(number) ?? []).map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: comment.createdAt,
          }));
          sendJson(res, 200, list);
          return;
        }
        if (method === 'POST') {
          const commentBody = typeof body?.body === 'string' ? body.body : '';
          const comment = { id: forge.nextCommentId(), body: commentBody, createdAt: FIXED_TIME };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: comment.createdAt });
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    // /pulls[/{n}[/files|/merge]]
    if (head === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
          const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((pull) => pull.state === state);
          list.sort((a, b) => b.number - a.number);
          const slice = list.slice((page - 1) * perPage, page * perPage);
          sendJson(res, 200, slice.map((pull) => pullJson(repo, pull)));
          return;
        }
        if (method === 'POST') {
          const title = typeof body?.title === 'string' ? body.title : '';
          const bodyText = typeof body?.body === 'string' ? body.body : '';
          const headRef = typeof body?.head === 'string' ? body.head : '';
          const baseRef = typeof body?.base === 'string' ? body.base : '';
          const created = createPull(forge, repo, title, bodyText, headRef, baseRef);
          if ('error' in created) {
            err(res, 422, created.error);
            return;
          }
          sendJson(res, 201, pullJson(repo, created.pull));
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number <= 0) {
        err(res, 404, 'Not Found');
        return;
      }
      const pull = repo.pulls.get(number);
      if (tail.length === 2) {
        if (pull === undefined) {
          err(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (pull === undefined) {
          err(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          const files = diffTrees(repo, treeOfCommit(repo, pull.baseSha), treeOfCommit(repo, pull.headSha));
          sendJson(res, 200, files);
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (pull === undefined) {
          err(res, 404, 'Not Found');
          return;
        }
        if (method === 'PUT') {
          if (pull.merged) {
            err(res, 405, 'Pull request already merged');
            return;
          }
          const sha = squashMerge(forge, repo, pull);
          if (sha === null) {
            err(res, 405, 'Merge conflict');
            return;
          }
          sendJson(res, 200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
          return;
        }
        err(res, 404, 'Not Found');
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }

    err(res, 404, 'Not Found');
  }

  /** Read one path out of a tree: a file object, or a directory listing array. */
  function readContentPath(repo: Repo, treeOid: string, contentPath: string): Record<string, unknown> | Array<Record<string, unknown>> | null {
    if (contentPath === '') {
      // The repository root as a directory listing.
      const object = repo.getObject(treeOid);
      if (object === undefined || object.type !== 'tree') return null;
      return parseTreeEntries(repo, object, '');
    }
    const segments = contentPath.split('/');
    let currentOid = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const object = repo.getObject(currentOid);
      if (object === undefined || object.type !== 'tree') return null;
      const entries = parseTreeEntriesRaw(object);
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      const last = index === segments.length - 1;
      if (entry.mode === '40000') {
        if (last) {
          const dirObject = repo.getObject(entry.oid);
          if (dirObject === undefined || dirObject.type !== 'tree') return null;
          return parseTreeEntries(repo, dirObject, contentPath);
        }
        currentOid = entry.oid;
        continue;
      }
      if (!last) return null;
      const blob = repo.getObject(entry.oid);
      if (blob === undefined || blob.type !== 'blob') return null;
      return {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: entry.name,
        path: contentPath,
        sha: entry.oid,
        content: blob.data.toString('base64'),
      };
    }
    return null;
  }

  function parseTreeEntriesRaw(object: { data: Buffer }): Array<{ mode: string; name: string; oid: string }> {
    return parseTree(object.data);
  }

  function parseTreeEntries(repo: Repo, object: { data: Buffer }, dirPath: string): Array<Record<string, unknown>> {
    return parseTree(object.data).map((entry) => {
      const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
      if (entry.mode === '40000') {
        return { type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 };
      }
      const blob = repo.getObject(entry.oid);
      return { type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 };
    });
  }

  return server;
}
