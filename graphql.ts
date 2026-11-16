// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send (see program/env/src/checks-graphql.ts GRAPHQL_DOCUMENTS).
// Hand-written tokenizer + recursive-descent parser + field resolvers over the same
// store the REST and MCP surfaces use. No dependencies.

import {
  FIXED_TIME,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  addComment,
  createIssue,
  createPull,
  decodeGlobalId,
  diffTrees,
  globalId,
  pullMergeable,
  setIssueState,
  squashMerge,
  treeOfCommit,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// tokenizer
// -------------------------------------------------------------------------------------------

type TokKind = 'name' | 'string' | 'int' | 'punct' | 'var' | 'spread';
interface Tok {
  kind: TokKind;
  value: string;
}

function tokenize(input: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'var', value: input.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Tok[];
  constructor(tokens: Tok[]) {
    this.tokens = tokens;
  }

  private peek(): Tok | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): Tok {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value}, got ${tok.value}`);
  }

  private expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`expected a name, got ${tok.value}`);
    if (value !== undefined && tok.value !== value) throw new Error(`expected ${value}, got ${tok.value}`);
    return tok.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== null) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let opType: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const tok = this.peek();
    if (tok?.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      opType = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
    }
    // Variable definitions: ($x: Type! = default, ...)
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.skipParens();
    }
    const selection = this.parseSelectionSet();
    return { opType, name, selection };
  }

  private skipParens(): void {
    let depth = 0;
    while (this.peek() !== null) {
      const tok = this.next();
      if (tok.kind === 'punct' && tok.value === '(') depth += 1;
      else if (tok.kind === 'punct' && tok.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== null && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const tok = this.peek();
    if (tok?.kind === 'spread') {
      this.next();
      this.expectName('on');
      const typeCondition = this.expectName();
      return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.next();
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'var') return { kind: 'var', name: tok.value };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${tok.value}`);
  }
}

// -------------------------------------------------------------------------------------------
// values: every GraphQL object is a plain record with __typename + a payload
// -------------------------------------------------------------------------------------------

type GqlValue = Record<string, unknown> & { __typename: string };

function issueValue(forge: Forge, repo: Repo, issue: Issue): GqlValue {
  void forge;
  return { __typename: 'Issue', repo, issue };
}

function pullValue(forge: Forge, repo: Repo, pull: Pull): GqlValue {
  void forge;
  return { __typename: 'PullRequest', repo, pull };
}

function repoValue(repo: Repo): GqlValue {
  return { __typename: 'Repository', repo };
}

// -------------------------------------------------------------------------------------------
// schema: the fields each type answers (an unknown field is a GraphQL error, HTTP 200)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'mergedAt', 'mergeCommitSha', 'author', 'createdAt', 'updatedAt'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI', 'PACKAGE', 'MARKETPLACE'];

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, ctx.variables);
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    if (!raw.startsWith('cursor:')) return -1;
    const n = Number.parseInt(raw.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

/** An issues connection over one repo's issues, honoring first/after/states/orderBy. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const field = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'ASC';
  void field;
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex + 1;
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const endIndex = start + page.length - 1;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueValue({} as Forge, repo, issue)),
    totalCount: list.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < list.length,
      endCursor: page.length > 0 ? cursorFor(endIndex) : null,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
    },
  };
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  let list = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
  list.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullValue({} as Forge, repo, pull)),
    totalCount: list.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: page.length < list.length,
      endCursor: page.length > 0 ? cursorFor(page.length - 1) : null,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor(0) : null,
    },
  };
}

/** Resolve one field of a value; returns undefined when the field is unknown (error recorded). */
function resolveField(value: GqlValue, field: FieldNode, ctx: Ctx): unknown {
  const typeName = value.__typename;
  const args = argsOf(field, ctx);
  if (field.name === '__typename') return typeName;

  const allowed = TYPE_FIELDS[typeName];
  if (allowed !== undefined && !allowed.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return undefined;
  }

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      }
      if (field.name === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = ctx.forge.getRepo(owner, name);
        if (repo === undefined || owner !== VIEWER_LOGIN) return null;
        return repoValue(repo);
      }
      if (field.name === 'node') {
        const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
        if (decoded === null) return null;
        const repo = ctx.forge.getRepoById(decoded.repoId);
        if (repo === undefined) return null;
        if (decoded.kind === 'Repository') return repoValue(repo);
        if (decoded.kind === 'Issue' && decoded.number !== undefined) {
          const issue = repo.issues.get(decoded.number);
          return issue === undefined ? null : issueValue(ctx.forge, repo, issue);
        }
        if (decoded.kind === 'PullRequest' && decoded.number !== undefined) {
          const pull = repo.pulls.get(decoded.number);
          return pull === undefined ? null : pullValue(ctx.forge, repo, pull);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        if (name === '' || (TYPE_FIELDS[name] === undefined && name !== 'SearchType')) return null;
        return { __typename: '__Type', typeName: name };
      }
      return null;
    }
    case 'User': {
      return value[field.name] ?? null;
    }
    case 'Repository': {
      const repo = value.repo as Repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return { __typename: 'User', login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
        case 'defaultBranchRef': {
          const tip = repo.branchTip(repo.defaultBranch);
          return tip === '' ? null : { __typename: 'Ref', name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'url':
          return `https://github.com/${repo.fullName}`;
        case 'description':
          return repo.description;
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.get(number);
          return issue === undefined ? null : issueValue(ctx.forge, repo, issue);
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequests':
          return pullRequestsConnection(repo, args);
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : pullValue(ctx.forge, repo, pull);
        }
        default:
          return null;
      }
    }
    case 'Ref':
      return value.name ?? null;
    case 'Issue': {
      const repo = value.repo as Repo;
      const issue = value.issue as Issue;
      switch (field.name) {
        case 'id':
          return globalId('Issue', repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'url':
          return `https://github.com/${repo.fullName}/issues/${issue.number}`;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'author':
          return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
        case 'labels':
          return issue.labels.map((label) => ({ name: label.name, color: label.color }));
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes' || field.name === 'edges') {
        if (field.name === 'edges') {
          const nodes = (value.nodes as GqlValue[] | undefined) ?? [];
          return nodes.map((node, index) => ({ __typename: 'IssueEdge', node, cursor: cursorFor(index) }));
        }
        return value.nodes ?? [];
      }
      if (field.name === 'pageInfo') return value.pageInfo ?? null;
      if (field.name === 'totalCount') return value.totalCount ?? 0;
      return null;
    }
    case 'IssueEdge':
      return field.name === 'node' ? value.node ?? null : value.cursor ?? null;
    case 'PageInfo':
      return value[field.name] ?? null;
    case 'PullRequest': {
      const repo = value.repo as Repo;
      const pull = value.pull as Pull;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pullMergeable(repo, pull);
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'headRefOid':
          return pull.headSha;
        case 'baseRefOid':
          return pull.baseSha;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeCommitSha':
          return pull.mergeCommitSha;
        case 'author':
          return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
        case 'createdAt':
        case 'updatedAt':
          return FIXED_TIME;
        case 'files': {
          const files = diffTrees(repo, treeOfCommit(repo, pull.baseSha), treeOfCommit(repo, pull.headSha));
          const first = typeof args.first === 'number' ? args.first : files.length;
          const nodes = files.slice(0, first).map((file) => ({
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            filename: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          }));
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes,
            totalCount: files.length,
            pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
          };
        }
        default:
          return null;
      }
    }
    case 'PullRequestChangedFile':
      return value[field.name] ?? null;
    case '__Type': {
      const typeName = value.typeName as string;
      if (field.name === 'name') return typeName;
      if (field.name === 'kind') return typeName === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[typeName] ?? [];
        return names.map((name) => ({ __typename: '__Field', name, description: null }));
      }
      if (field.name === 'enumValues') {
        if (typeName !== 'SearchType') return [];
        return SEARCH_TYPE_VALUES.map((name) => ({ __typename: '__EnumValue', name, description: null }));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue':
      return value[field.name] ?? null;
    case 'Mutation': {
      return resolveMutation(value, field, ctx);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field.name === 'issue') return value.issue ?? null;
      if (field.name === 'pullRequest') return value.pullRequest ?? null;
      return null;
    case 'AddCommentPayload':
      return field.name === 'commentEdge' ? value.commentEdge ?? null : null;
    case 'IssueCommentEdge':
      return field.name === 'node' ? value.node ?? null : value.cursor ?? null;
    case 'IssueComment':
      return value[field.name] ?? null;
    default:
      return value[field.name] ?? null;
  }
}

function resolveMutation(value: GqlValue, field: FieldNode, ctx: Ctx): unknown {
  void value;
  const args = argsOf(field, ctx);
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded === null ? undefined : ctx.forge.getRepoById(decoded.repoId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'createIssue: unknown repository' });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const created = createIssue(ctx.forge, repo, title, bodyText, []);
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return null;
      }
      return { __typename: 'CreateIssuePayload', issue: issueValue(ctx.forge, repo, created.issue) };
    }
    case 'closeIssue': {
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const repo = decoded === null ? undefined : ctx.forge.getRepoById(decoded.repoId);
      const issue = repo !== undefined && decoded?.number !== undefined ? repo.issues.get(decoded.number) : undefined;
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'closeIssue: unknown issue' });
        return null;
      }
      setIssueState(repo, issue, 'closed');
      return { __typename: 'CloseIssuePayload', issue: issueValue(ctx.forge, repo, issue) };
    }
    case 'createPullRequest': {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded === null ? undefined : ctx.forge.getRepoById(decoded.repoId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'createPullRequest: unknown repository' });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const created = createPull(ctx.forge, repo, title, bodyText, headRef, baseRef);
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return null;
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(ctx.forge, repo, created.pull) };
    }
    case 'mergePullRequest': {
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const repo = decoded === null ? undefined : ctx.forge.getRepoById(decoded.repoId);
      const pull = repo !== undefined && decoded?.number !== undefined ? repo.pulls.get(decoded.number) : undefined;
      if (repo === undefined || pull === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
        return null;
      }
      const sha = squashMerge(ctx.forge, repo, pull);
      if (sha === null) {
        ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(ctx.forge, repo, pull) };
    }
    case 'addComment': {
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const repo = decoded === null ? undefined : ctx.forge.getRepoById(decoded.repoId);
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const comment = repo !== undefined && decoded?.number !== undefined ? addComment(ctx.forge, repo, decoded.number, bodyText) : null;
      if (repo === undefined || comment === null) {
        ctx.errors.push({ message: 'addComment: unknown subject' });
        return null;
      }
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          cursor: cursorFor(0),
          node: { __typename: 'IssueComment', id: globalId('IssueComment', repo.id, comment.id), body: comment.body },
        },
      };
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      return null;
  }
}

/** Execute one selection set against a value, returning the JSON object. */
function executeSelection(value: GqlValue, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (value.__typename !== node.typeCondition) continue;
      Object.assign(out, executeSelection(value, node.selection, ctx));
      continue;
    }
    const key = node.alias ?? node.name;
    const resolved = resolveField(value, node, ctx);
    if (resolved === undefined) {
      out[key] = null;
      continue;
    }
    if (node.selection === null || node.selection.length === 0) {
      out[key] = resolved;
      continue;
    }
    if (resolved === null) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(resolved)) {
      out[key] = resolved.map((entry) =>
        entry !== null && typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)
          ? executeSelection(entry as GqlValue, node.selection!, ctx)
          : entry,
      );
      continue;
    }
    if (typeof resolved === 'object' && '__typename' in (resolved as Record<string, unknown>)) {
      out[key] = executeSelection(resolved as GqlValue, node.selection, ctx);
      continue;
    }
    out[key] = resolved;
  }
  return out;
}

function executeOperation(forge: Forge, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { forge, variables, errors: [] };
  const root: GqlValue = operation.opType === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelection(root, operation.selection, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Execute one {query, variables} document (or a batch array); returns {status, contentType, body}. */
export function handleGraphQL(forge: Forge, rawBody: Buffer): { status: number; contentType: string; body: Buffer } {
  const jsonType = 'application/json; charset=utf-8';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, contentType: jsonType, body: Buffer.from('{"errors":[{"message":"Problems parsing JSON"}]}\n', 'utf8') };
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
    }
    const record = doc as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax error' }] };
    }
    let operation = operations[0];
    if (operation === undefined) return { data: null, errors: [{ message: 'Empty document' }] };
    if (operationName !== null) {
      const named = operations.find((op) => op.name === operationName);
      if (named !== undefined) operation = named;
    }
    return executeOperation(forge, operation, variables);
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map(runOne);
    return { status: 200, contentType: jsonType, body: Buffer.from(`${JSON.stringify(results)}\n`, 'utf8') };
  }
  const result = runOne(parsed);
  return { status: 200, contentType: jsonType, body: Buffer.from(`${JSON.stringify(result)}\n`, 'utf8') };
}
