# Agents and widgets

Two parts of the API let your own product reach your EchoNova agents:

- **Widget tickets** let one signed-in visitor open a private website widget.
- **Agent sessions** start a live voice or chat session with an agent, which your own app then joins.

Both hand out a secret that opens a session for one person, and starting a session spends your workspace's credits. So both belong on your server, behind your own sign-in.

## Call them from your server only

- **Never call these from a browser or an app.** The API key must stay on your server (see [Authentication](authentication.md)). Your backend decides which of your users may open a widget or start a session, makes the call, and passes the result to that user's client over your own authenticated connection.
- The [reference proxies](../../proxy-examples/README.md) leave these routes out on purpose: forwarding them would let any signed-in user start sessions at will. Call them from your own backend code instead.
- **The key needs the right access.** Widget tickets need access to Agents on the key; agent sessions need the "Talk to agents" (`agents:talk`) scope. Without it the API answers with `PermissionDeniedError` (`PermissionDeniedException` in Dart).

## Widget tickets

A private widget opens only with a ticket. `widgets.create_ticket()` (`createTicket()`) mints one for a visitor of your site who is signed in to your product:

- `public_id` is the widget ID from the widget's settings; it starts with `wdg_`. The widget must be private and turned on.
- `user` describes the visitor: `id` is your own ID for them (the widget's per-visitor daily limit counts by it), and `name` is shown in Conversations.
- `channel` restricts the ticket to `voice` or `chat`; leave it out to allow both.
- `ttl_seconds` (`ttlSeconds`) is how long the ticket stays valid. The allowed range and the default are in the published [OpenAPI spec](https://api.echonova.ai/openapi.json) (`POST /v1/widgets/{publicId}/tickets`).

The result holds the `ticket` and when it expires (`expires_at`, `expiresAt`). A ticket works once and starts one widget session. **Treat it as a secret:** send it only to that visitor's browser, and don't log or store it. Minting is free, so if a call fails or the visitor needs another session, mint a new ticket; one that is never used simply expires.

**Python**

```python
from echonova import EchoNova

client = EchoNova()  # a key with access to Agents
WIDGET_ID = "wdg_a1B2c3D4e5F6g7H8i9J0"  # from the widget's settings


def widget_ticket(user_id: str, user_name: str) -> dict[str, str]:
    """Call this from your own endpoint, for the visitor who is signed in to it."""
    minted = client.widgets.create_ticket(WIDGET_ID, user={"id": user_id, "name": user_name}, ttl_seconds=300)
    expires = minted.expires_at.isoformat() if minted.expires_at else ""
    return {"ticket": minted.ticket, "expiresAt": expires}  # for this visitor's browser only
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova(); // a key with access to Agents
const widgetId = 'wdg_a1B2c3D4e5F6g7H8i9J0'; // from the widget's settings

/** Call this from your own endpoint, for the visitor who is signed in to it. */
async function widgetTicket(userId: string, userName: string): Promise<{ ticket: string; expiresAt: string }> {
  const { ticket, expiresAt } = await client.widgets.createTicket(widgetId, {
    user: { id: userId, name: userName },
    ttlSeconds: 300,
  });
  return { ticket, expiresAt }; // for this visitor's browser only
}
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova(); // a key with access to Agents
const widgetId = 'wdg_a1B2c3D4e5F6g7H8i9J0'; // from the widget's settings

/// Call this from your own endpoint, for the visitor who is signed in to it.
Future<Map<String, String>> widgetTicket(String userId, String userName) async {
  final minted = await client.widgets.createTicket(
    widgetId,
    user: WidgetUser(id: userId, name: userName),
    ttlSeconds: 300,
  );
  return {
    'ticket': minted.ticket, // for this visitor's browser only
    'expiresAt': minted.expiresAt?.toIso8601String() ?? '',
  };
}
```

A widget that doesn't exist (or belongs to another workspace) raises `NotFoundError`; one that is public, which needs no ticket, or turned off raises `InvalidRequestError` with the API's message.

## Agent sessions

A live session is the same session the Test button on an agent runs in the portal. You start it from your server, your user's app joins the room, and you end it when the user is done. How the app joins (the public docs use the `livekit-client` package) is on [Live sessions with an agent](https://echonova.ai/docs/developers/live-sessions).

- `agents.sessions.start(agent_id, channel=...)` starts a `voice` session (the API's default) or a `chat` session. The result has the session `id`, its `status`, the room address `ws_url` (`wsUrl`) and the room `token`. A chat session's first agent message is in `greeting`.
- `agents.sessions.get(agent_id, session_id)` returns the status: `active` while it is open, then `ended`, or `failed` or `out_of_credits` when it stopped early. Treat any other value as not active.
- `agents.sessions.end(agent_id, session_id)` ends the session and closes its room. Ending a session that already ended returns its final status, so it is safe to call twice.

**Python**

```python
from echonova import EchoNova

client = EchoNova()  # a key with the agents:talk scope
agent_id = "..."  # the agent's ID

session = client.agents.sessions.start(agent_id, channel="voice")
# Send these to the one client that joins the room, over your own authenticated connection.
join = {"sessionId": session.id, "wsUrl": session.ws_url, "token": session.token}

status = client.agents.sessions.get(agent_id, session.id).status  # active, ended, failed, out_of_credits
client.agents.sessions.end(agent_id, session.id)  # when the user is done
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova(); // a key with the agents:talk scope
const agentId = '...'; // the agent's ID

const session = await client.agents.sessions.start(agentId, { channel: 'voice' });
// Send these to the one client that joins the room, over your own authenticated connection.
const join = { sessionId: session.id, wsUrl: session.wsUrl, token: session.token };

const { status } = await client.agents.sessions.get(agentId, session.id); // active, ended, failed, out_of_credits
await client.agents.sessions.end(agentId, session.id); // when the user is done
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova(); // a key with the agents:talk scope
const agentId = '...'; // the agent's ID

final session = await client.agents.sessions.start(agentId, channel: AgentChannel.voice);
// Send these to the one client that joins the room, over your own authenticated connection.
final join = {'sessionId': session.id, 'wsUrl': session.wsUrl, 'token': session.token};

final status = (await client.agents.sessions.get(agentId, session.id)).status; // active, ended, ...
await client.agents.sessions.end(agentId, session.id); // when the user is done
client.close();
```

### The room token is a secret

The `token` opens the session's room. The API sends it only in the response to `start()`; `get()` and `end()` never return it.

- Hand it only to the client that joins the room. Don't log it, store it or put it in a URL.
- The SDK keeps it out of its own logs and errors. In Python it is left out of `repr()`, but `to_dict()` and `.raw` include it. In Node.js, `console.log(session)` shows it as `[secret]`, but `JSON.stringify(session)` keeps it. In Dart it is left out of `toString()`.
- A token opens one session. To talk again, start a new session.

### `start` isn't retried after a lost response

A retried start opens a second session, so the SDK sends `start()` again only when no session can have started: the connection never opened, or the API answered with a rate limit that says when to retry, or said that live sessions are unavailable. If the request was sent and the response was lost, the SDK raises an error with `may_have_executed` (`mayHaveExecuted`) set instead. The session may be open; there is no session ID to check it with, so don't start another one blindly.

**Python**

```python
from echonova import APIConnectionError, ConcurrencyLimitError, EchoNova

client = EchoNova()
agent_id = "..."  # the agent's ID

try:
    session = client.agents.sessions.start(agent_id, channel="chat")
    print(session.greeting)  # show it before the user types
except ConcurrencyLimitError:
    print("The agent is busy. Try again in a moment.")  # at its chat limit
except APIConnectionError as e:
    if not e.may_have_executed:
        raise
    print("The session may have started: don't start another one blindly.")
```

**TypeScript**

```ts
import EchoNova, { APIConnectionError, ConcurrencyLimitError } from '@echonova/ai';

const client = new EchoNova();
const agentId = '...'; // the agent's ID

try {
  const session = await client.agents.sessions.start(agentId, { channel: 'chat' });
  console.log(session.greeting); // show it before the user types
} catch (err) {
  if (err instanceof ConcurrencyLimitError) console.log('The agent is busy. Try again in a moment.'); // at its chat limit
  else if (err instanceof APIConnectionError && err.mayHaveExecuted) {
    console.log("The session may have started: don't start another one blindly.");
  } else throw err;
}
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();
const agentId = '...'; // the agent's ID

try {
  final session = await client.agents.sessions.start(agentId, channel: AgentChannel.chat);
  print(session.greeting); // show it before the user types
} on ConcurrencyLimitException {
  print('The agent is busy. Try again in a moment.'); // at its chat limit
} on APIConnectionException catch (e) {
  if (e.mayHaveExecuted != true) rethrow;
  print("The session may have started: don't start another one blindly.");
}
client.close();
```

### Limits and credits

What the API docs say about live sessions (see [Live sessions with an agent](https://echonova.ai/docs/developers/live-sessions) for the current values):

- A session uses workspace credits, as a test in the portal does. They don't count against the key's Credit Limit. A workspace with no credits is refused before the session starts (`InsufficientBalanceError`), and nothing is charged.
- The agent's own call and chat limits apply. An agent at its limit raises `ConcurrencyLimitError`.
- Starts are rate-limited per key. The SDK waits and retries when the API says how long to wait, then raises `RateLimitError`.
- An archived agent can't start sessions: restore it first.

## See also

- [Live sessions with an agent](https://echonova.ai/docs/developers/live-sessions): joining a voice or chat room from your app.
- API reference: [start](https://echonova.ai/docs/reference/agents-start-session), [get](https://echonova.ai/docs/reference/agents-get-session) and [end](https://echonova.ai/docs/reference/agents-end-session) a session.
- [Errors](errors.md): what each error means and what to do.
