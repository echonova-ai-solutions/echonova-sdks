/// Map stream error frames and close codes to SDK exceptions.
///
/// The close frame decides whether a stream is over. An `error` frame on its
/// own is never fatal; when one arrives just before a close, its code and
/// message are attached to the exception for that close.
library;

import 'dart:convert';

import '../errors.dart';
import 'types.dart';

/// Closes after which a session can't continue and reconnecting won't help.
const Set<int> fatalCloseCodes = {1002, 1007, 1008, 1009, 4002, 4029};

/// Closes after which `transcribeStream` reconnects.
const Set<int> reconnectCloseCodes = {1001, 1006, 1011};

const int _rawLimit = 4096;

/// How a socket ended.
final class CloseInfo {
  /// Creates close information.
  const CloseInfo(
    this.code, {
    this.reason = '',
    this.local = false,
    this.lostReason,
  });

  /// The close code (1006 when there was no close frame).
  final int code;

  /// The close reason.
  final String reason;

  /// The SDK closed it (`close()`, rotation).
  final bool local;

  /// Set when the SDK gave up on an unresponsive connection.
  final String? lostReason;

  /// No clean close: the connection dropped, timed out, or the server is
  /// restarting.
  bool get abnormal => lostReason != null || code == 1001 || code == 1006;

  @override
  String toString() => 'CloseInfo($code${reason.isEmpty ? '' : ' $reason'}'
      '${local ? ', local' : ''}'
      '${lostReason == null ? '' : ', lost: $lostReason'})';
}

String _raw(Map<String, Object?> event) {
  final text = jsonEncode(event, toEncodable: (value) => '$value');
  return text.length <= _rawLimit ? text : text.substring(0, _rawLimit);
}

String? _string(Object? value) => value is String ? value : null;

/// The exception for an `error` frame (`{type, code, message, requestId?}`).
APIStatusException errorFromFrame(
  Map<String, Object?> event, {
  String? sessionId,
}) {
  final code = switch (event['code']) {
    final String c when c.isNotEmpty => c,
    _ => null,
  };
  final message = _string(event['message']);
  final requestId = _string(event['requestId']);
  final raw = _raw(event);
  const transport = TransportKind.websocket;
  return switch (code) {
    'validation_failed' => InvalidRequestException(
        errorMessage: message,
        errorCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: raw,
        transport: transport,
      ),
    'voice_not_found' => VoiceNotFoundException(
        errorMessage: message,
        errorCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: raw,
        transport: transport,
      ),
    'insufficient_balance' => InsufficientBalanceException(
        errorMessage: message,
        errorCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: raw,
        transport: transport,
      ),
    'spending_limit' => SpendingLimitException(
        errorMessage: message,
        errorCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: raw,
        transport: transport,
      ),
    'upstream_error' => UpstreamException(
        errorMessage: message,
        errorCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: raw,
        transport: transport,
      ),
    'invalid_message' || 'frame_too_large' => ProtocolException(
        errorMessage: message,
        errorCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: raw,
        transport: transport,
      ),
    _ => APIStatusException(
        errorMessage: message,
        errorCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: raw,
        transport: transport,
      ),
  };
}

/// The exception for a close, or `null` when the close is a normal end.
///
/// [endedNormally] is `true` when Speech to Text sent `session.ended` first.
/// [lastError] is an `error` frame that arrived just before the close.
EchoNovaException? closeError(
  CloseInfo info, {
  bool endedNormally = false,
  Map<String, Object?>? lastError,
  String? sessionId,
  bool? mayHaveExecuted,
}) {
  final code = info.code;
  final reason = info.reason;
  final errorMessage = _string(lastError?['message']);
  final errorCode = _string(lastError?['code']);
  final requestId = _string(lastError?['requestId']);
  final rawBody = lastError == null ? null : _raw(lastError);
  final reasonText = reason.isEmpty ? null : reason;

  String text(String fallback) => errorMessage ?? reasonText ?? fallback;

  if (info.lostReason != null || code == 1006) {
    final detail = info.lostReason ?? 'closed without a close frame (1006)';
    return StreamConnectionLostException(
      'stream connection lost: $detail',
      mayHaveExecuted: mayHaveExecuted,
    );
  }
  if (info.local) return null;
  switch (code) {
    case 1000:
      if (endedNormally) return null;
      return StreamClosedException(
        'the server closed the stream (1000${reasonText == null ? '' : ': '
            '$reasonText'})',
        closeCode: code,
        reason: reasonText,
        sessionId: sessionId,
      );
    case 1001:
      return ServerRestartingException(
        'the server is restarting (1001); reconnect',
        closeCode: code,
        reason: reasonText,
        sessionId: sessionId,
      );
    case 1002 || 1007 || 1008 || 1009:
      final fallback = switch (code) {
        1002 => 'protocol error',
        1007 => 'invalid frame data',
        1008 => 'policy violation',
        _ => 'frame too big',
      };
      return ProtocolException(
        errorMessage: text(fallback),
        errorCode: errorCode,
        closeCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: rawBody,
        transport: TransportKind.websocket,
      );
    case 1011:
      return UpstreamException(
        errorMessage: text('the speech service failed'),
        errorCode: errorCode,
        closeCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: rawBody,
        transport: TransportKind.websocket,
      );
    case 4002:
      return InsufficientBalanceException(
        errorMessage: text('insufficient balance'),
        errorCode: errorCode,
        closeCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: rawBody,
        transport: TransportKind.websocket,
      );
    case 4029:
      return SpendingLimitException(
        errorMessage: text('spending limit reached'),
        errorCode: errorCode,
        closeCode: code,
        requestId: requestId,
        sessionId: sessionId,
        rawBody: rawBody,
        transport: TransportKind.websocket,
      );
    case 4008:
      if (endedNormally) return null;
      return SessionExpiredException(
        'the stream session expired (${reasonText ?? 'timeout'})',
        closeCode: code,
        reason: reasonText,
        sessionId: sessionId,
      );
  }
  return StreamClosedException(
    'the stream closed with code $code'
    '${reasonText == null ? '' : ': $reasonText'}',
    closeCode: code,
    reason: reasonText,
    sessionId: sessionId,
  );
}

final Expando<ChargeState> _chargeStates = Expando('chargeState');
final Expando<double> _credits = Expando('creditsConsumed');

/// Records on [error] whether the synthesis it ended was charged.
E attachChargeState<E extends Object>(E error, ChargeState state) {
  _chargeStates[error] = state;
  return error;
}

/// Whether the synthesis that failed with [error] was charged: [ChargeState]
/// for an exception from a synthesis that failed or was lost, `null` for any
/// other error.
///
/// ```dart
/// try {
///   await synthesis.result;
/// } on StreamConnectionLostException catch (error) {
///   if (chargeStateOf(error) == ChargeState.no) {
///     // Safe to send it again: it was never charged.
///   }
/// }
/// ```
ChargeState? chargeStateOf(Object error) => _chargeStates[error];

/// Records on [error] the final cost the server reported for the synthesis
/// it ended (nothing when [credits] is `null`).
E attachCreditsConsumed<E extends Object>(E error, double? credits) {
  if (credits != null) _credits[error] = credits;
  return error;
}

/// The final cost the server reported for the synthesis that failed with
/// [error] (a speech service failure after its audio started costs the share
/// of audio sent, at least 1 credit), or `null` when it reported none.
double? creditsConsumedOf(Object error) => _credits[error];
