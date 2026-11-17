import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  LeavecalcClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Leave Loading Calculator
 * endpoint is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/leaveloadingcalculator-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const DESCRIBE = "calculator_describe";
const CALCULATE = "calculate";
const ENQ_DESCRIBE = "enquiry_describe";
const ENQ_FIELDS = "enquiry_fields";
const OMITTED = "submit_enquiry";
const ALL_TOOLS = [DESCRIBE, CALCULATE, ENQ_DESCRIBE, ENQ_FIELDS];

const SAMPLE_RESULT = {
  content: [
    { type: "text", text: "{\"weeklyPay\":1615,\"loading\":848.63}" },
  ],
  structuredContent: { weeklyPay: 1615, loading: 848.63 },
};

const SAMPLE_ARGS = {
  hourlyRate: 42.5,
  hoursPerWeek: 38,
  leaveWeeks: 3,
  loadingPct: 17.5,
  penaltyPct: 25,
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "leaveloadingcalculator", version: "1.0.1" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new LeavecalcClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function defOf(name: string): ToolDef {
  const def = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(def !== undefined, `missing tool def ${name}`);
  return def;
}

/* CLI helpers (also used by the omission suite). */

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
}

/* MCP client over an in-memory transport, for tools/list and
 * tools/call assertions at the MCP layer itself. */
async function withMcpClient<T>(
  upstream: { fetchFn: FetchFn },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createServer({ fetchFn: upstream.fetchFn, env: {} });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "leavecalc-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 4 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 4);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 4 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's titles verbatim", () => {
    assert.deepEqual(
      TOOL_DEFS.map((t) => t.title),
      [
        "What Annual leave loading calculator computes",
        "Annual leave loading calculator",
        "What you get: an ENQUIRY with a human (not a purchase, not a guaranteed quote)",
        "The questions the enquiry asks",
      ],
    );
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.match(defOf(CALCULATE).description, /Missing inputs fall back/);
    assert.match(defOf(ENQ_DESCRIBE).description, /human providers who quote directly/);
  });

  it("carries NO required key on any tool (all four served verbatim)", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal("required" in schemaOf(tool), false);
      assert.equal(schemaOf(tool).required, undefined);
    }
  });

  it("carries the $schema marker and object type on every inputSchema", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal(
        schemaOf(tool)["$schema"],
        "http://json-schema.org/draft-07/schema#",
      );
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
  });

  it("the two describe tools and enquiry_fields take no properties", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(DESCRIBE)).properties), []);
    assert.deepEqual(Object.keys(schemaOf(defOf(ENQ_DESCRIBE)).properties), []);
    assert.deepEqual(Object.keys(schemaOf(defOf(ENQ_FIELDS)).properties), []);
  });

  it("calculate carries the five pay inputs in fixture order", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(CALCULATE)).properties), [
      "hourlyRate",
      "hoursPerWeek",
      "leaveWeeks",
      "loadingPct",
      "penaltyPct",
    ]);
    for (const key of Object.keys(schemaOf(defOf(CALCULATE)).properties)) {
      assert.equal(schemaOf(defOf(CALCULATE)).properties[key].type, "number");
    }
  });

  it("calculate carries the captured ranges and defaults", () => {
    const props = schemaOf(defOf(CALCULATE)).properties;
    assert.deepEqual(
      [props.hourlyRate.minimum, props.hourlyRate.maximum, props.hourlyRate.default],
      [0, 500, 35],
    );
    assert.deepEqual(
      [props.hoursPerWeek.minimum, props.hoursPerWeek.maximum, props.hoursPerWeek.default],
      [1, 60, 38],
    );
    assert.deepEqual(
      [props.leaveWeeks.minimum, props.leaveWeeks.maximum, props.leaveWeeks.default],
      [0, 20, 4],
    );
    assert.deepEqual(
      [props.loadingPct.minimum, props.loadingPct.maximum, props.loadingPct.default],
      [0, 100, 17.5],
    );
    assert.deepEqual(
      [props.penaltyPct.minimum, props.penaltyPct.maximum, props.penaltyPct.default],
      [0, 200, 0],
    );
  });

  it("calculate carries the captured property descriptions", () => {
    const props = schemaOf(defOf(CALCULATE)).properties;
    assert.equal(props.hourlyRate.description, "Base hourly rate");
    assert.equal(props.hoursPerWeek.description, "Ordinary hours per week");
    assert.equal(props.leaveWeeks.description, "Weeks of annual leave being paid");
    assert.equal(props.loadingPct.description, "Leave loading in your award or agreement");
    assert.equal(props.penaltyPct.description, "Weekend or shift penalties you normally get");
  });

  it("additionalProperties is false on calculate and absent on the other three", () => {
    assert.equal(schemaOf(defOf(CALCULATE)).additionalProperties, false);
    for (const name of [DESCRIBE, ENQ_DESCRIBE, ENQ_FIELDS]) {
      assert.equal("additionalProperties" in schemaOf(defOf(name)), false);
    }
  });

  it("isKnownTool recognises the built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("calculator"), false);
    assert.equal(isKnownTool("submit"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("labelled omission: submit_enquiry is absent", () => {
  it("the omitted tool is not among the served tool names (registry level)", () => {
    assert.equal(TOOL_NAMES.includes(OMITTED), false);
    assert.equal(TOOL_DEFS.some((t) => t.name === OMITTED), false);
    assert.equal(TOOL_DEFS.length, 4);
  });

  it("isKnownTool rejects the omitted tool (registry level)", () => {
    assert.equal(isKnownTool(OMITTED), false);
  });

  it("the MCP layer rejects submit_enquiry as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () =>
        handleCallTool(c, OMITTED, {
          answers: { name: "Jane Example", email: "jane@example.com" },
        }),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("the MCP tools/list response carries exactly the 4 built tools and not submit_enquiry", async (t) => {
    if (skipWithoutFixture(t)) return;
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => {
      const res = await client.listTools();
      return res.tools;
    });
    assert.deepEqual(
      listed.map((t) => t.name),
      ALL_TOOLS,
    );
    assert.equal(listed.some((t) => t.name === OMITTED), false);
    assert.deepEqual(listed, fixture.tools);
    assert.equal(upstream.calls.length, 0);
  });

  it("an MCP tools/call for submit_enquiry is rejected and never reaches the upstream", async () => {
    const upstream = makeUpstream();
    await withMcpClient(upstream, async (client) => {
      await assert.rejects(() =>
        client.callTool({ name: OMITTED, arguments: { answers: {} } }),
      );
    });
    assert.equal(upstream.calls.length, 0);
  });

  it("the omitted submit_enquiry tool is not a CLI command and exits 2", () => {
    const res = runCli([OMITTED, "{}"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.doesNotMatch(res.stderr, /one of: [^\n]*submit_enquiry/);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(
      DEFAULT_ENDPOINT_URL,
      "https://leaveloadingcalculator.com/mcp",
    );
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name leavecalc and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "leavecalc", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    await c.callTool(ENQ_FIELDS, {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the LEAVELOADINGCALCULATOR_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new LeavecalcClient({
      fetchFn: upstream.fetchFn,
      env: { LEAVELOADINGCALCULATOR_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { LEAVELOADINGCALCULATOR_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new LeavecalcClient({
      fetchFn: upstream.fetchFn,
      env: { LEAVELOADINGCALCULATOR_MCP_URL: "   " },
    });
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header is ever sent (record declares NO headers)", () => {
  it("sends no Authorization header when the environment is empty", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when a LEAVELOADINGCALCULATOR_API_KEY-style env var is present", async () => {
    const upstream = makeUpstream();
    const c = new LeavecalcClient({
      fetchFn: upstream.fetchFn,
      env: { LEAVELOADINGCALCULATOR_API_KEY: "some-key-42" },
    });
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("sends no Authorization header even when AUTHORIZATION / API_KEY env vars are present", async () => {
    const upstream = makeUpstream();
    const c = new LeavecalcClient({
      fetchFn: upstream.fetchFn,
      env: {
        AUTHORIZATION: "Bearer x",
        API_KEY: "y",
        LEAVELOADINGCALCULATOR_TOKEN: "z",
      },
    });
    await c.callTool(DESCRIBE, {});
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new LeavecalcClient({
      fetchFn: upstream.fetchFn,
      env: { LEAVELOADINGCALCULATOR_API_KEY: "some-key-42" },
    });
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a calculate call verbatim with every input", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CALCULATE, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CALCULATE);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a calculate call with empty arguments (defaults apply upstream)", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(CALCULATE, {});
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CALCULATE);
    assert.deepEqual(params.arguments, {});
  });

  it("forwards calculator_describe under its own name with empty arguments", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(DESCRIBE, {});
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, DESCRIBE);
    assert.deepEqual(params.arguments, {});
  });

  it("forwards enquiry_fields under its own name", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(ENQ_FIELDS, {});
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, ENQ_FIELDS);
    assert.deepEqual(params.arguments, {});
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "rate out of range upstream" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(CALCULATE, { hourlyRate: 9999 });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      ENQ_DESCRIBE,
      {},
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, ENQ_DESCRIBE);
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as leavecalc error text", () => {
  it("maps a JSON-RPC error to `leavecalc error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "calculation failed upstream" },
    });
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "leavecalc error: calculation failed upstream");
  });

  it("maps an initialize JSON-RPC error to leavecalc error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "leavecalc error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "leavecalc error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "leavecalc error: malformed response");
  });

  it("maps a non-2xx upstream status to leavecalc error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "leavecalc error: HTTP 500");
  });

  it("maps a throwing fetch to leavecalc error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^leavecalc error: /);
  });

  it("maps a throwing initialize fetch to leavecalc error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "leavecalc error: socket hang up");
  });

  it("maps a timed-out call to leavecalc error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(CALCULATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^leavecalc error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, CALCULATE, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, CALCULATE, "hourlyRate=42"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid calculate call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, CALCULATE, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a valid enquiry_fields call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, ENQ_FIELDS, {});
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, ENQ_FIELDS);
    assert.deepEqual(params.arguments, {});
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, DESCRIBE, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(
      res.stderr,
      /calculator_describe, calculate, enquiry_describe, enquiry_fields/,
    );
  });

  it("no command at all prints usage on stderr and exits 2", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([CALCULATE, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([CALCULATE, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after a tool exit 2", () => {
    const res = runCli([CALCULATE, "{}", "extra"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
