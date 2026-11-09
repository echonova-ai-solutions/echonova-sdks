/// Request parameters with structure: terminology and widget visitors.
library;

import 'dart:convert';

/// Terms the transcript should spell your way: names, products and
/// acronyms. Nothing is stored between requests, so send the full list
/// every time.
///
/// ```dart
/// final terms = Terminology([
///   Keyword('KYC'),
///   Keyword('Emirates NBD', variants: ['امريتس ان بي دي']),
///   Keyword('SWIFT', contextWords: ['transfer', 'تحويل']),
/// ]);
/// ```
final class Terminology {
  /// Creates a terminology from [keywords].
  const Terminology(this.keywords) : _json = null;

  /// A terminology given as the API's JSON (`{"keywords": [...]}`), for
  /// options this SDK version doesn't model yet.
  const Terminology.fromJson(Map<String, Object?> json)
      : keywords = const [],
        _json = json;

  /// The keywords.
  final List<Keyword> keywords;

  final Map<String, Object?>? _json;

  /// The API's JSON: `{"keywords": [...]}`.
  Map<String, Object?> toJson() =>
      _json ??
      {
        'keywords': [for (final keyword in keywords) keyword.toJson()]
      };

  /// The JSON text sent as the `terminology` form field.
  String encode() => jsonEncode(toJson());

  @override
  String toString() => 'Terminology(${_json == null ? keywords.length : '?'} '
      'keywords)';
}

/// One terminology entry. With no options it is sent as a plain string.
final class Keyword {
  /// Creates a keyword.
  ///
  /// * [variants]: other spellings or pronunciations that mean this term.
  /// * [blocked]: phrases that must never become this term.
  /// * [contextWords]: words that must appear nearby for the term to apply
  ///   (with [needsContext]).
  const Keyword(
    this.term, {
    this.variants,
    this.blocked,
    this.contextWords,
    this.needsContext,
  });

  /// The term, written exactly as the transcript should spell it.
  final String term;

  /// Other spellings that mean this term.
  final List<String>? variants;

  /// Phrases that must never be replaced by this term.
  final List<String>? blocked;

  /// Words that signal the term is meant.
  final List<String>? contextWords;

  /// Whether the term applies only near one of [contextWords].
  final bool? needsContext;

  /// The API's JSON: the term itself, or an object with its options.
  Object toJson() {
    if (variants == null &&
        blocked == null &&
        contextWords == null &&
        needsContext == null) {
      return term;
    }
    return {
      'term': term,
      if (variants case final variants?) 'variants': variants,
      if (blocked case final blocked?) 'blocked': blocked,
      if (contextWords case final words?) 'context_words': words,
      if (needsContext case final needsContext?) 'needs_context': needsContext,
    };
  }

  @override
  String toString() => 'Keyword($term)';
}

/// The signed-in visitor a widget ticket is for.
final class WidgetUser {
  /// Creates a visitor.
  const WidgetUser({this.id, this.name});

  /// Your own ID for the visitor, 1 to 128 characters. The widget's
  /// per-visitor daily limit counts by it.
  final String? id;

  /// The name shown in Conversations, up to 80 characters.
  final String? name;

  /// The API's JSON.
  Map<String, Object?> toJson() => {
        if (id case final id?) 'id': id,
        if (name case final name?) 'name': name,
      };

  @override
  String toString() => 'WidgetUser(id: $id)';
}
