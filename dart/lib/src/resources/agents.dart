/// Agents: widget tickets and agent sessions, called from your server.
library;

import 'package:meta/meta.dart';

import '../errors.dart';
import '../models/agents.dart';
import '../models/enums.dart';
import '../operations.dart';
import '../params.dart';
import '../response.dart';
import '../transport/http_transport.dart' show ApiRequest;
import 'context.dart';

final _parseTicket = modelParser(WidgetTicket.fromJson, 'WidgetTicket');
final _parseStarted =
    modelParser(StartedAgentSession.fromJson, 'StartedAgentSession');
final _parseSession = modelParser(AgentSession.fromJson, 'AgentSession');

/// Website widgets: `client.widgets`.
final class Widgets {
  /// Internal: the client creates it.
  @internal
  Widgets(this._context);

  final ClientContext _context;

  /// Mints a ticket that lets one visitor open a private widget. Call it
  /// from your server, and hand the ticket to that visitor's browser.
  ///
  /// * [publicId]: the widget ID from the widget settings (`wdg_…`).
  /// * [user]: the signed-in visitor the ticket is for.
  /// * [channel]: restricts the ticket to voice or chat; both when unset.
  /// * [ttlSeconds]: how long the ticket stays valid, 60 to 900 (the API's
  ///   default is 300). It works once.
  Future<WidgetTicket> createTicket(
    String publicId, {
    WidgetUser? user,
    AgentChannel? channel,
    int? ttlSeconds,
    RequestOptions? options,
  }) =>
      _context.call(
        _request(publicId, user, channel, ttlSeconds, options),
        _parseTicket,
      );

  /// [createTicket], returning the HTTP response too.
  Future<RawResponse<WidgetTicket>> createTicketWithResponse(
    String publicId, {
    WidgetUser? user,
    AgentChannel? channel,
    int? ttlSeconds,
    RequestOptions? options,
  }) =>
      _context.callRaw(
        _request(publicId, user, channel, ttlSeconds, options),
        _parseTicket,
      );

  ApiRequest _request(
    String publicId,
    WidgetUser? user,
    AgentChannel? channel,
    int? ttlSeconds,
    RequestOptions? options,
  ) {
    if (publicId.trim().isEmpty) {
      throw UsageException(
        'publicId is the widget ID from the widget settings (it starts with '
        'wdg_)',
      );
    }
    return _context.request(
      widgetsCreateTicket,
      path: {'publicId': publicId},
      json: compact({
        'user': user?.toJson(),
        'channel': channel?.value,
        'ttlSeconds': ttlSeconds,
      }),
      options: options,
    );
  }
}

/// Agents: `client.agents`.
final class Agents {
  /// Internal: the client creates it.
  @internal
  Agents(ClientContext context) : sessions = AgentSessions._(context);

  /// Sessions with your agents.
  final AgentSessions sessions;
}

/// Agent sessions: `client.agents.sessions`.
///
/// Start a session on your server, then hand the room token to the one
/// client that joins.
final class AgentSessions {
  AgentSessions._(this._context);

  final ClientContext _context;

  /// Starts a session with agent [agentId]: a voice room
  /// ([AgentChannel.voice], the API's default) or a text chat
  /// ([AgentChannel.chat]).
  ///
  /// The result carries the room token, which the API sends only this once:
  /// keep it secret. A start whose response was lost is never retried,
  /// because a second attempt would open a second session; the exception
  /// then says `mayHaveExecuted`.
  Future<StartedAgentSession> start(
    String agentId, {
    AgentChannel? channel,
    RequestOptions? options,
  }) =>
      _context.call(_start(agentId, channel, options), _parseStarted);

  /// [start], returning the HTTP response too.
  Future<RawResponse<StartedAgentSession>> startWithResponse(
    String agentId, {
    AgentChannel? channel,
    RequestOptions? options,
  }) =>
      _context.callRaw(_start(agentId, channel, options), _parseStarted);

  ApiRequest _start(
    String agentId,
    AgentChannel? channel,
    RequestOptions? options,
  ) =>
      _context.request(
        agentSessionsStart,
        path: {'agentId': agentId},
        json: compact({'channel': channel?.value}),
        options: options,
      );

  /// Gets a session.
  Future<AgentSession> get(
    String agentId,
    String sessionId, {
    RequestOptions? options,
  }) =>
      _context.call(
        _session(agentSessionsGet, agentId, sessionId, options),
        _parseSession,
      );

  /// [get], returning the HTTP response too.
  Future<RawResponse<AgentSession>> getWithResponse(
    String agentId,
    String sessionId, {
    RequestOptions? options,
  }) =>
      _context.callRaw(
        _session(agentSessionsGet, agentId, sessionId, options),
        _parseSession,
      );

  /// Ends a session.
  Future<AgentSession> end(
    String agentId,
    String sessionId, {
    RequestOptions? options,
  }) =>
      _context.call(
        _session(agentSessionsEnd, agentId, sessionId, options),
        _parseSession,
      );

  /// [end], returning the HTTP response too.
  Future<RawResponse<AgentSession>> endWithResponse(
    String agentId,
    String sessionId, {
    RequestOptions? options,
  }) =>
      _context.callRaw(
        _session(agentSessionsEnd, agentId, sessionId, options),
        _parseSession,
      );

  ApiRequest _session(
    Operation operation,
    String agentId,
    String sessionId,
    RequestOptions? options,
  ) =>
      _context.request(
        operation,
        path: {'agentId': agentId, 'sessionId': sessionId},
        options: options,
      );
}
