// MCP `instructions` payload fragments shared between irc-server.ts (which
// emits them) and bin/roost-token-usage (which greps for them inside
// session JSONLs to map a transcript back to its roost nick).
//
// Physically centralized so the coupling is a function call, not a string
// match: a future rename or consolidation of the active/passive variants
// either touches this helper or breaks the producer at the call site.

// The single line every owner MCP instance announces on startup. The
// passive variant in irc-server.ts deliberately uses a different wording
// (`passive instance for nick "<nick>"`) and is NOT matched by the token
// tool — passive MCPs don't run a Claude session whose tokens we'd want
// to attribute to a nick.
export function mcpConnectionLine(nick: string): string {
  return `You are connected to IRC as nick "${nick}"`
}
