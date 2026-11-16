// mcp.ts — JSON-RPC 2.0 Streamable HTTP for /mcp.
// Modern era (2026-07-28): server/discover. Legacy fallback: initialize +
// notifications/initialized. Tools run on the same store as REST/GraphQL.
// The tools/list payload is built once and reused byte-for-byte.

import {
  VIEWER_LOGIN,
  createIssue,
  createPull,
  squashMerge,
  type Forge,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// tool definitions (frozen; tools/list returns this exact JSON every time)
// -------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const TOOLS_LIST_RESULT = JSON.stringify({ tools: TOOLS });

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

const DISCOVER_RESULT = JSON.stringify({
  supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
  capabilities: { tools: {} },
  serverInfo: SERVER_INFO,
});

// -------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1 },
    description: repo.description,
    private: false,
    default_branch: repo.defaultBranch,
    created_at: '2026-11-14T06:30:00Z',
    updated_at: '2026-11-14T06:30:00Z',
  };
}

function issueJson(repo: Repo, issue: ReturnType<typeof createIssue> extends { issue: infer I } ? I : never): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: ReturnType<typeof createPull> extends { pull: infer P } ? P : never): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

function toolTextResult(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true, structuredContent: { error: message } };
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function resolveRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if (name === '' && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = parts[0] ?? '';
      name = parts[1] ?? '';
    }
  }
  if (owner === '' || name === '') return null;
  return forge.getRepo(owner, name) ?? null;
}

function missingRequired(args: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') return key;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// tools/call dispatch
// -------------------------------------------------------------------------------------------

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const lower = name.toLowerCase();
  const base = lower.split('_').pop() ?? lower;
  const matches = (suffix: string): boolean => lower === suffix || lower.endsWith(`_${suffix}`) || base === suffix;
  if (matches('create_repo')) {
    const missing = missingRequired(args, ['name']);
    if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
    const repoName = String(args.name);
    const existing = forge.getRepo(VIEWER_LOGIN, repoName);
    if (existing !== undefined) return toolErrorResult(`Repository '${repoName}' already exists`);
    const description = typeof args.description === 'string' ? args.description : '';
    const repo = forge.createRepo(repoName, description, false);
    return toolTextResult(repoJson(repo));
  }
  if (matches('get_repo')) {
    const repo = resolveRepo(forge, args);
    if (repo === null) return toolErrorResult('Repository not found');
    return toolTextResult(repoJson(repo));
  }
  if (matches('create_issue')) {
    const missing = missingRequired(args, ['owner', 'repo', 'title']);
    if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
    const repo = resolveRepo(forge, args);
    if (repo === null) return toolErrorResult('Repository not found');
    const body = typeof args.body === 'string' ? args.body : '';
    const created = createIssue(forge, repo, String(args.title), body, []);
    if ('error' in created) return toolErrorResult(created.error);
    return toolTextResult(issueJson(repo, created.issue));
  }
  if (matches('list_issues')) {
    const missing = missingRequired(args, ['owner', 'repo']);
    if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
    const repo = resolveRepo(forge, args);
    if (repo === null) return toolErrorResult('Repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => a.number - b.number);
    return toolTextResult(list.map((issue) => issueJson(repo, issue)));
  }
  if (matches('create_pull_request')) {
    const missing = missingRequired(args, ['owner', 'repo', 'title', 'head', 'base']);
    if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
    const repo = resolveRepo(forge, args);
    if (repo === null) return toolErrorResult('Repository not found');
    const body = typeof args.body === 'string' ? args.body : '';
    const created = createPull(forge, repo, String(args.title), body, String(args.head), String(args.base));
    if ('error' in created) return toolErrorResult(created.error);
    return toolTextResult(pullJson(repo, created.pull));
  }
  if (matches('merge_pull_request')) {
    const missing = missingRequired(args, ['owner', 'repo', 'pull_number']);
    if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
    const repo = resolveRepo(forge, args);
    if (repo === null) return toolErrorResult('Repository not found');
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolErrorResult('Pull request not found');
    const sha = squashMerge(forge, repo, pull);
    if (sha === null) return toolErrorResult('Merge conflict');
    return toolTextResult(pullJson(repo, pull));
  }
  return { __rpcError: -32601, __rpcMessage: `Unknown tool: ${name}` };
}

// -------------------------------------------------------------------------------------------
// entry point: POST /mcp
// -------------------------------------------------------------------------------------------

/**
 * Handle one JSON-RPC request body. Returns {status, contentType, body}.
 * `headers` supplies the request headers (for the protocol-version header).
 */
export function handleMcp(
  forge: Forge,
  rawBody: Buffer,
  headers?: Record<string, string | string[] | undefined>,
): { status: number; contentType: string; body: Buffer } {
  const jsonType = 'application/json; charset=utf-8';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, contentType: jsonType, body: Buffer.from(`${rpcError(null, -32700, 'Parse error')}\n`, 'utf8') };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, contentType: jsonType, body: Buffer.from(`${rpcError(null, -32600, 'Invalid Request')}\n`, 'utf8') };
  }
  const record = parsed as Record<string, unknown>;
  const id = record.id ?? null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) never get a response body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, contentType: jsonType, body: Buffer.alloc(0) };
  }

  switch (method) {
    case 'server/discover': {
      return { status: 200, contentType: jsonType, body: Buffer.from(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${DISCOVER_RESULT}}\n`, 'utf8') };
    }
    case 'initialize': {
      const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
      const result = {
        protocolVersion: clientVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
      return { status: 200, contentType: jsonType, body: Buffer.from(`${rpcResult(id, result)}\n`, 'utf8') };
    }
    case 'tools/list': {
      void headers;
      // The list must be byte-for-byte identical across calls: same frozen JSON,
      // only the JSON-RPC id differs.
      return { status: 200, contentType: jsonType, body: Buffer.from(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${TOOLS_LIST_RESULT}}\n`, 'utf8') };
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(forge, toolName, args);
      if ('__rpcError' in outcome) {
        const code = outcome.__rpcError as number;
        const message = String(outcome.__rpcMessage ?? 'Unknown tool');
        return { status: 200, contentType: jsonType, body: Buffer.from(`${rpcError(id, code, message)}\n`, 'utf8') };
      }
      return { status: 200, contentType: jsonType, body: Buffer.from(`${rpcResult(id, outcome)}\n`, 'utf8') };
    }
    case 'ping': {
      return { status: 200, contentType: jsonType, body: Buffer.from(`${rpcResult(id, {})}\n`, 'utf8') };
    }
    default: {
      return { status: 200, contentType: jsonType, body: Buffer.from(`${rpcError(id, -32601, `Method not found: ${method}`)}\n`, 'utf8') };
    }
  }
}
