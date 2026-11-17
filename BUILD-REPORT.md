# BUILD REPORT — leavecalc

Clean-room rebuild of `com.leaveloadingcalculator/site` v1.0.1
(remote-only MCP server at `https://leaveloadingcalculator.com/mcp`),
built 2026-10-28 as a forwarding client. Package: `@reneturcios/leavecalc`
0.1.0, registry name `io.github.CloudCorpRecords/leavecalc`.

## Surface built

Labelled subset: **4 of 5 captured tools built**, 1 omitted (see below).

| Tool | Required fields as served |
|------|---------------------------|
| `calculator_describe` | *(none — no `required` key in the capture, served verbatim)* |
| `calculate` | *(none — no `required` key in the capture, served verbatim)* |
| `enquiry_describe` | *(none — no `required` key in the capture, served verbatim)* |
| `enquiry_fields` | *(none — no `required` key in the capture, served verbatim)* |

Each served tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, with the `inputSchema.$schema` marker
(`http://json-schema.org/draft-07/schema#`) exactly as captured.
`calculate` additionally carries `additionalProperties: false` and its
five numeric inputs (`hourlyRate`, `hoursPerWeek`, `leaveWeeks`,
`loadingPct`, `penaltyPct`) with the captured ranges, defaults and
descriptions; the other three tools take empty `properties`. No tool
carries a `required` key — none was invented; missing inputs fall back
to documented defaults upstream, per the captured description.
The tool literals were generated programmatically from
`harness/fixtures/leaveloadingcalculator-tools-original.json` by the
script at `/tmp/laneb4-leavecalc-scratch/gen.py` (parse + re-serialise,
splice into `src/forward.ts`) — never retyped — and the generator's
own post-generation check, the registration-integrity test suite, and
the parity harness each confirmed the served literals deep-equal the
fixture's 4 tool objects, in order. Tools are registered via the MCP
SDK low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

## Omission — `submit_enquiry`

- OMITTED: `submit_enquiry` — submits a person's enquiry `answers`
  (with a consent + confirmation flow) to human providers who quote
  directly. The person's details leave to third-party providers:
  PII lead routing / submission. Absence is asserted in tests at
  three levels: registry level (`TOOL_DEFS` / `TOOL_NAMES` /
  `isKnownTool`), MCP layer (an in-memory-transport `tools/list`
  response carries exactly the 4 built tools and deep-equals the
  fixture; `handleCallTool` and an MCP `tools/call` for
  `submit_enquiry` are rejected before any network hop), and CLI
  level (`leavecalc submit_enquiry '{}'` exits 2 with usage and is
  not listed among the commands). The two enquiry documentation
  reads (`enquiry_describe`, `enquiry_fields`) are kept: they
  describe the omitted tool's contract as published data and submit
  nothing themselves.

## Fixture conflicts

**None.** The spec and the fixture agree on the tools' names, titles,
descriptions, the absence of any `required` key on all four tools,
and the property shapes. The fixture already excludes the omitted
tool, exactly as the spec's Omissions section describes.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://leaveloadingcalculator.com/mcp`.
- Env override `LEAVELOADINGCALCULATOR_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent, under any environment. Tests assert that no
  `Authorization` header (and no `X-API-Key` header) is sent with an
  empty environment, with a `LEAVELOADINGCALCULATOR_API_KEY`-style
  variable present, and with `AUTHORIZATION` / `API_KEY` /
  `LEAVELOADINGCALCULATOR_TOKEN` variables present.
- Error rendering `leavecalc error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; plain-JSON and SSE replies are both parsed. The
  forwarding core takes an injectable fetch; tests stub the
  upstream — no live network calls in tests, and no live call is
  claimed.

## Deviations

None.

## Lockfile

- Route: generated clean from birth in the build dir with no
  `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`
  (Route 3), then populated with `npm ci --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/leavecalc`.
- Package entries: **128**.
- sha256: `002a36b44ac4c00d5d3386985356b0321f7c0905c56b5b66077c3b586a16b197`
  (re-verified unchanged after the subsequent offline `npm ci`).

## server.json

- Description exactly: "Annual leave loading calculator plus its
  published inputs, tables and enquiry fields." — **85 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/leavecalc:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio. Dockerfile
  (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/leavecalc"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/leavecalc`
  and its smoke test asserts the server name `leavecalc`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **68 tests, 68 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 4
   tools; the omission suite asserts `submit_enquiry` absent at
   registry, MCP-layer — tools/list and tools/call — and CLI level;
   plus session handling/reuse, env override, the
   no-Authorization-header assertions under every environment,
   verbatim argument forwarding and result pass-through including
   upstream isError, SSE parsing, error rendering, MCP-layer
   validation, and CLI behaviour).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/leaveloadingcalculator-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/leavecalc/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/leavecalc/parity-out` → **verdict PASS, parity 100.0**
   (4/4 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
