# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Leave Loading Calculator MCP server. The four captured tools of the labelled subset are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `calculator_describe`, `calculate`, `enquiry_describe`, `enquiry_fields`. The captured `submit_enquiry` tool is deliberately omitted: it submits a person's enquiry answers to third-party human providers (PII lead routing), which this rebuild does not do. The two enquiry documentation reads are kept — they publish what the enquiry asks and who receives details, and submit nothing themselves.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `leavecalc error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `LEAVELOADINGCALCULATOR_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent.
