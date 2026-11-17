# leavecalc

Work out what annual leave loading is worth without reimplementing someone else's award tables. leavecalc is a small forwarding client for the hosted Leave Loading Calculator MCP service: the tool list is served from your own machine using the captured definitions, and each call is sent upstream, with the service's answer returned exactly as it arrived.

Four of the service's five captured tools are exposed. You can read what the calculator takes and assumes, run the calculation itself over your own pay figures, and read the published documentation for the service's enquiry form — what it asks, and who receives the details. The fifth captured tool, `submit_enquiry`, is deliberately left out: it sends a person's answers to third-party human providers, and this rebuild does not route anyone's personal details anywhere. The two enquiry reads stay because they publish information; they submit nothing.

## The tools

- **`calculator_describe`** — The calculator's inputs with their units, ranges and defaults, the outputs it produces, and the assumptions and tables behind the numbers. No arguments.
- **`calculate`** — Run the calculation: base weekly pay, base pay for the leave period, the leave loading itself, and the penalties you would otherwise have earned. Every input is optional — `hourlyRate` (default 35), `hoursPerWeek` (default 38), `leaveWeeks` (default 4), `loadingPct` (default 17.5) and `penaltyPct` (default 0) — and anything omitted falls back to its documented default upstream.
- **`enquiry_describe`** — A plain statement of what the enquiry does: it starts an enquiry with human providers who quote directly; nothing is bought and no quote is guaranteed. Also covers who receives the details, the consent wording, and how the person confirms. No arguments.
- **`enquiry_fields`** — Every field of the enquiry form: key, label, type, whether it is required, help text, and the allowed options where there are any. No arguments.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/leavecalc mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "leavecalc": {
      "command": "npx",
      "args": ["-y", "@reneturcios/leavecalc", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/leavecalc
docker run --rm ghcr.io/cloudcorprecords/leavecalc calculator_describe '{}'
```

## CLI

A single binary covers both the command line and the MCP server. Every tool is a subcommand whose one argument is a JSON string of that tool's inputs:

```bash
leavecalc calculator_describe '{}'
leavecalc calculate '{"hourlyRate":42,"leaveWeeks":3}'
leavecalc calculate '{}'
leavecalc enquiry_describe '{}'
leavecalc enquiry_fields '{}'
leavecalc --version
```

Exit codes: `0` for a successful forwarded call, `1` when the result that comes back is an error, and `2` for usage mistakes like an unknown subcommand or a JSON argument that does not parse. `submit_enquiry` is not a subcommand and exits `2` like any other unknown name.

## Configuration

- `LEAVELOADINGCALCULATOR_MCP_URL` — Replaces the upstream endpoint. Defaults to the pinned hosted endpoint, `https://leaveloadingcalculator.com/mcp`. (This override variable is a reconstruction introduced by this rebuild.)

The Leave Loading Calculator registry record lists no headers for its remote, so leavecalc never attaches an authentication header — every call goes upstream keyless.

When the upstream cannot answer — it returns a JSON-RPC error, answers with a non-2xx status, sends a body that cannot be read, or the request itself fails — the caller receives an error result whose text begins with `leavecalc error:`.

## How forwarding works

The first call of a process opens a session against the upstream: an `initialize` request (protocol version `2025-03-26`), a `notifications/initialized` notification, and then the `tools/call`. If the service issues an `Mcp-Session-Id` header during initialize, leavecalc repeats it on subsequent requests and keeps reusing that one session until the process ends. Replies are understood in both plain JSON and server-sent-events framing. Successful results are passed through untouched, `isError` flag and any extra fields included.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The suite compares the served tool list against the captured surface tool for tool, asserts the omitted `submit_enquiry` tool is absent at the registry, MCP and CLI levels, walks the session handshake and its reuse, proves no `Authorization` header is sent under any environment, and confirms that arguments travel upstream unchanged and results return unchanged.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
