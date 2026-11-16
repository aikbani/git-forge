# git-forge — a GitHub-compatible git forge (make.fun `github-core-clone-01`)

A single-process Node 22 server (stdlib only: `node:http`, `node:zlib`, `node:crypto`)
implementing the scored surface: git smart HTTP (upload-pack v2, receive-pack v0),
REST v3, GraphQL v4, and MCP over streamable HTTP — all on one in-memory store, with
deterministic state (fixed timestamps, sequential ids, no wall-clock or randomness in
responses). No `git` binary, no dependencies, no outside service.

Local rehearsal against the kit's runner (identical checks to the sealed suite):
**120/120 conformance (feature 600 + agent 200)**; perf p50 ~700 µs on this shared VM
(noisy; the sealed trial's 2 dedicated CPUs will differ — handler CPU for the clone
workload was cut ~50× by caching whole fetch responses, see below).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own `app.ts` only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: HTTP server, routing, REST v3, dispatch to git/GraphQL/MCP.
- `store.ts`: SHA-1 object store, pack read/write, repo/issues/pulls model, merges, global ids.
- `git.ts`: pkt-lines, v2 advertisements/ls-refs/fetch, v0 fetch, receive-pack (fast-forward rules).
- `graphql.ts`: hand-written GraphQL parser + executor for the `gh` / `github-mcp-server` documents.
- `mcp.ts`: JSON-RPC 2.0 Streamable HTTP (`server/discover`, `initialize`, `tools/list`, `tools/call`).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

## Notes worth knowing

- Real `git` (2.43) clones `--depth 1` from this server. Its upload-pack omits the
  `acknowledgments` section for a single-round fetch, and its reader dies on a present
  one (`expected 'packfile', received 'acknowledgments'`), so `fetchV2` omits it too;
  the suite's fetch parser treats the section as optional.
- A delete-only push carries no packfile: the receive-pack parser must not mistake the
  trailing flush packet for pack bytes.
- Perf: whole fetch-v2 responses, ls-refs answers and v0 advertisements are cached per
  repo state (`refsVersion`); GET-issue serves a pre-encoded cached Buffer via a fast
  path; the pack cache is keyed by repo + refsVersion + wants + depth.

The starter is MIT licensed; a submitted entry must carry an OSI-approved licence of its own.
