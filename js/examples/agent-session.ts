/**
 * Agent sessions: start a live session with an agent from your server, check it, then end it.
 *
 * The room token in the result is a secret: hand it only to the client that joins
 * the room (your web or mobile app), and never log or store it. This script prints
 * the session without it.
 *
 *     ECHONOVA_API_KEY=ek_... node --experimental-strip-types examples/agent-session.ts AGENT_ID [voice|chat]
 */

import { setTimeout as sleep } from 'node:timers/promises';
import EchoNova, { ConcurrencyLimitError } from '@echonova/ai';

const [agentId, channel = 'voice'] = process.argv.slice(2);
if (!agentId) {
  console.error('usage: node --experimental-strip-types examples/agent-session.ts AGENT_ID [voice|chat]');
  process.exit(2);
}

/** Stand-in for your API's response to the app that joins the room. */
function handToClient(wsUrl: string, token: string): { wsUrl: string; token: string } {
  return { wsUrl, token };
}

const client = new EchoNova();

const session = await client.agents.sessions.start(agentId, { channel }).catch((err: unknown) => {
  if (!(err instanceof ConcurrencyLimitError)) throw err;
  console.log('the agent is at its call or chat limit:', err.errorMessage);
  return null;
});
if (session === null) process.exit(0);

console.log({ id: session.id, channel: session.channel, status: session.status }); // never the token
if (session.greeting) console.log('agent:', session.greeting);
handToClient(session.wsUrl, session.token);

try {
  await sleep(10_000); // your app joins the room and talks to the agent meanwhile
  console.log('status:', (await client.agents.sessions.get(agentId, session.id)).status);
} finally {
  const ended = await client.agents.sessions.end(agentId, session.id); // safe to call twice
  console.log('ended:', ended.status, ended.endedAt);
}
