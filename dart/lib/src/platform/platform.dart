/// Platform-specific helpers, chosen at compile time.
///
/// `dart:io` platforms (servers, Flutter mobile and desktop) get
/// `platform_io.dart`; the web gets `platform_web.dart`.
library;

export 'platform_web.dart' if (dart.library.io) 'platform_io.dart';
