/// File access, chosen at compile time: real files on `dart:io` platforms,
/// and an [UnsupportedError]-style failure on the web, which has no file
/// system.
library;

export 'files_web.dart' if (dart.library.io) 'files_io.dart';
