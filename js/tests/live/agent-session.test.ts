// Live, optional: start a chat session with the test agent, check it, end it. Chat is the
// cheaper channel; the session uses workspace credits. The room token is never printed.
import { afterAll, describe, expect } from 'vitest';
import type EchoNova from '../../src/index.js';
import { clientFor, liveTest, note, required, scrubbing, since } from './support.js';

let client: EchoNova | null = null;
const api = (): EchoNova => (client ??= clientFor(required('ECHONOVA_API_KEY')));

afterAll(() => scrubbing(async () => void (await client?.close())));

describe('agent sessions', () => {
  liveTest('(17) agents.sessions: start a chat session, get it, end it', ['ECHONOVA_API_KEY', 'ECHONOVA_AGENT_ID'], async () => {
    const agentId = required('ECHONOVA_AGENT_ID');
    const sessions = api().agents.sessions;
    const started = performance.now();
    const session = await sessions.start(agentId, { channel: 'chat' });
    let ended = false;
    try {
      note(`agents.sessions.start: ${session.status} in ${since(started)}, request ${session.requestId}`);
      expect(session.agentId).toBe(agentId);
      expect(session.channel).toBe('chat');
      expect(session.status).toBe('active');
      expect(session.endedAt).toBeNull();
      expect(typeof session.token === 'string' && session.token.length > 0).toBe(true);
      expect(typeof session.wsUrl === 'string' && session.wsUrl.length > 0).toBe(true);

      const current = await sessions.get(agentId, session.id);
      expect(current.id).toBe(session.id);
      expect(current.channel).toBe('chat');
      expect('token' in current).toBe(false); // sent once, by start()

      const final = await sessions.end(agentId, session.id);
      ended = true;
      note(`agents.sessions.end: ${final.status}, request ${final.requestId}`);
      expect(final.id).toBe(session.id);
      expect(final.status).not.toBe('active');
      expect(final.endedAt).toBeTruthy();
    } finally {
      if (!ended) await sessions.end(agentId, session.id); // ending twice is safe
    }
  });
});
