/// Open enumerations: the documented values are constants, and any other
/// value the API sends is kept as it is instead of failing to parse.
library;

/// The status of a job.
///
/// Besides [pending], [processing], [completed] and [failed], treat any
/// other value as "not finished": check [isTerminal].
final class JobStatus {
  const JobStatus._(this.value);

  /// The status for [value], one of the constants when it is documented.
  factory JobStatus(String value) => switch (value) {
        'pending' => pending,
        'processing' => processing,
        'completed' => completed,
        'failed' => failed,
        _ => JobStatus._(value),
      };

  /// Accepted, not started.
  static const pending = JobStatus._('pending');

  /// Running.
  static const processing = JobStatus._('processing');

  /// Finished: the result is ready.
  static const completed = JobStatus._('completed');

  /// Finished without a result: see the job's `error`.
  static const failed = JobStatus._('failed');

  /// The documented statuses.
  static const values = [pending, processing, completed, failed];

  /// The status as the API sent it.
  final String value;

  /// Whether this is one of the documented [values].
  bool get isKnown => values.contains(this);

  /// Whether the job has finished ([completed] or [failed]).
  bool get isTerminal => this == completed || this == failed;

  @override
  bool operator ==(Object other) => other is JobStatus && other.value == value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => value;
}

/// How a visitor talks to an agent: a voice room or a text chat.
final class AgentChannel {
  const AgentChannel._(this.value);

  /// The channel for [value], one of the constants when it is documented.
  factory AgentChannel(String value) => switch (value) {
        'voice' => voice,
        'chat' => chat,
        _ => AgentChannel._(value),
      };

  /// A room you speak in.
  static const voice = AgentChannel._('voice');

  /// A text session.
  static const chat = AgentChannel._('chat');

  /// The documented channels.
  static const values = [voice, chat];

  /// The channel as the API names it.
  final String value;

  /// Whether this is one of the documented [values].
  bool get isKnown => values.contains(this);

  @override
  bool operator ==(Object other) =>
      other is AgentChannel && other.value == value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => value;
}

/// The state of an agent session.
final class AgentSessionStatus {
  const AgentSessionStatus._(this.value);

  /// The status for [value], one of the constants when it is documented.
  factory AgentSessionStatus(String value) => switch (value) {
        'active' => active,
        'ended' => ended,
        'failed' => failed,
        'out_of_credits' => outOfCredits,
        _ => AgentSessionStatus._(value),
      };

  /// Open.
  static const active = AgentSessionStatus._('active');

  /// Ended by you, or finished.
  static const ended = AgentSessionStatus._('ended');

  /// Stopped early because of an error.
  static const failed = AgentSessionStatus._('failed');

  /// Stopped early because the account ran out of credits.
  static const outOfCredits = AgentSessionStatus._('out_of_credits');

  /// The documented statuses.
  static const values = [active, ended, failed, outOfCredits];

  /// The status as the API sent it.
  final String value;

  /// Whether this is one of the documented [values].
  bool get isKnown => values.contains(this);

  /// Whether the session is over (any status but [active]).
  bool get isOver => this != active;

  @override
  bool operator ==(Object other) =>
      other is AgentSessionStatus && other.value == value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => value;
}

/// The format of a transcript export.
enum ExportFormat {
  /// The transcript text.
  txt,

  /// Subtitles, one cue every few seconds, each tagged with its speaker
  /// when known.
  srt,

  /// Text, speakers and timed segments. `exportJson` parses it.
  json,
}
