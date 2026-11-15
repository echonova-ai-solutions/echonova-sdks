// Agent sessions: start a session with an agent from your server, check it,
// then end it.
//
// The room token in the result is a secret: hand it only to the client that
// joins the room (your web or mobile app), and never log or store it.
// Printing the session leaves the token out.
//
// Run:
//
//     ECHONOVA_API_KEY=... dart run example/agent_session.dart AGENT_ID [voice|chat]
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

Future<void> main(List<String> args) async {
  if (args.isEmpty) {
    stderr.writeln('usage: dart run example/agent_session.dart AGENT_ID '
        '[voice|chat]');
    exitCode = 64;
    return;
  }
  final agentId = args[0];
  final channel = args.length > 1 ? AgentChannel(args[1]) : AgentChannel.voice;

  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    final StartedAgentSession session;
    try {
      session = await client.agents.sessions.start(agentId, channel: channel);
    } on ConcurrencyLimitException catch (error) {
      stdout.writeln('the agent is at its call or chat limit: '
          '${error.errorMessage}');
      return;
    }
    stdout.writeln(session); // without the token
    if (session.greeting case final greeting?) {
      stdout.writeln('agent: $greeting'); // chat sessions open with one
    }
    handToClient(session.wsUrl, session.token);

    try {
      // Your app joins the room and talks to the agent meanwhile.
      await Future<void>.delayed(const Duration(seconds: 10));
      final current = await client.agents.sessions.get(agentId, session.id);
      stdout.writeln('status: ${current.status}');
    } finally {
      final ended = await client.agents.sessions.end(agentId, session.id);
      stdout.writeln('ended: ${ended.status} at ${ended.endedAt}');
    }
  } finally {
    client.close();
  }
}

/// Stand-in for your API's response to the app that joins the room.
Map<String, String?> handToClient(String? wsUrl, String token) =>
    {'wsUrl': wsUrl, 'token': token};
