/** Live voice and chat sessions with an agent. Needs the `agents:talk` scope on the key. */

import type { APIPromise } from '../core/api-promise.js';
import { OPS } from '../core/operations.js';
import type { AgentSession, StartedAgentSession } from '../types/models.js';
import type { RequestOptions, StartSessionParams } from '../types/params.js';
import { APIResource, compact, model, type ClientContext } from './resource.js';

const parseSession = model<AgentSession>('AgentSession', ['id', 'status']);
const parseStarted = model<StartedAgentSession>('StartedAgentSession', ['id', 'status', 'token']);

/** `console.log(session)` in Node shows the token as `[secret]`; JSON keeps it, to hand to the joining client. */
function hideToken(session: StartedAgentSession): StartedAgentSession {
  Object.defineProperty(session, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => ({ ...session, token: '[secret]' }),
  });
  return session;
}

export class AgentSessions extends APIResource {
  /**
   * Start a voice or chat session and get its room token and address.
   *
   * The token is sent only in this response: hand it to the client that joins
   * and keep it out of logs. Uses workspace credits; the agent's own chat and
   * call limits apply. Because a second start would open a second session, the
   * SDK never resends a start whose response was lost: the error then has
   * `mayHaveExecuted: true`, and `get()` or the agent's history shows whether it opened.
   */
  start(agentId: string, params: StartSessionParams = {}, options?: RequestOptions): APIPromise<StartedAgentSession> {
    return this._request(
      OPS.agentSessionsStart,
      { path: { agentId }, json: compact({ channel: params.channel }), parse: (data, meta) => hideToken(parseStarted(data, meta)) },
      options,
    );
  }

  /** The session's status. The token is never returned again. */
  get(agentId: string, sessionId: string, options?: RequestOptions): APIPromise<AgentSession> {
    return this._request(OPS.agentSessionsGet, { path: { agentId, sessionId }, parse: parseSession }, options);
  }

  /** End the session and close its room. Ending a session that already ended returns its final status, so it is safe to call again. */
  end(agentId: string, sessionId: string, options?: RequestOptions): APIPromise<AgentSession> {
    return this._request(OPS.agentSessionsEnd, { path: { agentId, sessionId }, parse: parseSession }, options);
  }
}

export class Agents extends APIResource {
  readonly sessions: AgentSessions;

  constructor(client: ClientContext) {
    super(client);
    this.sessions = new AgentSessions(client);
  }
}
