/// Widget tickets and agent sessions.
library;

import 'base.dart';
import 'enums.dart';

/// A single-use ticket that lets one visitor open a private widget. Hand it
/// to that visitor's browser only.
final class WidgetTicket extends ApiResult {
  WidgetTicket._(
    super.raw, {
    required super.requestId,
    required this.ticket,
    required this.expiresAt,
  });

  /// Parses the API's JSON. Throws [FormatException] without `ticket`.
  factory WidgetTicket.fromJson(
    Map<String, Object?> json, {
    String? requestId,
  }) =>
      WidgetTicket._(
        json,
        requestId: requestId,
        ticket: requireString(json, 'ticket', 'WidgetTicket'),
        expiresAt: readDateTime(json['expiresAt']),
      );

  /// The ticket. It starts one session. [toString] doesn't show it.
  final String ticket;

  /// When the ticket stops working, in UTC.
  final DateTime? expiresAt;

  @override
  String toString() =>
      'WidgetTicket(expiresAt: ${expiresAt?.toIso8601String()})';
}

/// An agent session: a voice room or a text chat with one of your agents.
base class AgentSession extends ApiResult {
  AgentSession._(
    super.raw, {
    required super.requestId,
    required this.id,
    required this.agentId,
    required this.channel,
    required this.status,
    required this.startedAt,
    required this.endedAt,
  });

  /// Parses the API's JSON. Throws [FormatException] without `id` or
  /// `status`.
  factory AgentSession.fromJson(
    Map<String, Object?> json, {
    String? requestId,
  }) =>
      AgentSession._(
        json,
        requestId: requestId,
        id: requireString(json, 'id', 'AgentSession'),
        agentId: readString(json['agentId']),
        channel: _channel(json['channel']),
        status:
            AgentSessionStatus(requireString(json, 'status', 'AgentSession')),
        startedAt: readDateTime(json['startedAt']),
        endedAt: readDateTime(json['endedAt']),
      );

  /// The session ID; also the conversation ID once it ends.
  final String id;

  /// The agent's ID.
  final String? agentId;

  /// [AgentChannel.voice] or [AgentChannel.chat].
  final AgentChannel? channel;

  /// The session's state; anything but [AgentSessionStatus.active] means it
  /// is over.
  final AgentSessionStatus status;

  /// When it started, in UTC.
  final DateTime? startedAt;

  /// When it ended, or `null` while it is open.
  final DateTime? endedAt;

  @override
  String toString() => 'AgentSession(id: $id, agentId: $agentId, '
      'channel: $channel, status: $status)';
}

/// A session that just started, with the room [token] the joining client
/// needs.
///
/// The API sends the token once, here, and never again. Keep it secret and
/// hand it only to the client that joins. [toString] doesn't show it.
final class StartedAgentSession extends AgentSession {
  StartedAgentSession._(
    super.raw, {
    required super.requestId,
    required super.id,
    required super.agentId,
    required super.channel,
    required super.status,
    required super.startedAt,
    required super.endedAt,
    required this.token,
    required this.wsUrl,
    required this.greeting,
  }) : super._();

  /// Parses the API's JSON. Throws [FormatException] without `id`, `status`
  /// or `token`.
  factory StartedAgentSession.fromJson(
    Map<String, Object?> json, {
    String? requestId,
  }) =>
      StartedAgentSession._(
        json,
        requestId: requestId,
        id: requireString(json, 'id', 'StartedAgentSession'),
        agentId: readString(json['agentId']),
        channel: _channel(json['channel']),
        status: AgentSessionStatus(
          requireString(json, 'status', 'StartedAgentSession'),
        ),
        startedAt: readDateTime(json['startedAt']),
        endedAt: readDateTime(json['endedAt']),
        token: requireString(json, 'token', 'StartedAgentSession'),
        wsUrl: readString(json['wsUrl']),
        greeting: readString(json['greeting']),
      );

  /// The room token. Secret: give it only to the client that joins.
  final String token;

  /// The room address the client connects to with [token].
  final String? wsUrl;

  /// A chat session's first agent message; `null` for voice.
  final String? greeting;

  @override
  String toString() => 'StartedAgentSession(id: $id, agentId: $agentId, '
      'channel: $channel, status: $status)';
}

AgentChannel? _channel(Object? value) {
  final text = readString(value);
  return text == null ? null : AgentChannel(text);
}
