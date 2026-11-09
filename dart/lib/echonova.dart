/// Official Dart and Flutter SDK for the EchoNova speech API: Text to
/// Speech, Speech to Text and Sound Cleaning.
///
/// * Server-side Dart: `EchoNova(apiKey: ...)`.
/// * Flutter apps: `EchoNova.proxy(baseUrl: ..., auth: ...)`, through your
///   own backend, so the API key never ships in the app.
/// * Webhooks: `verifyWebhook`.
///
/// Every error is an `EchoNovaException`; `switch` over it to handle each
/// kind.
library;

export 'src/client.dart' show EchoNova, defaultBaseUrl;
export 'src/core/rate_limit.dart' show RateLimitInfo;
export 'src/errors.dart';
export 'src/version.dart' show packageVersion;
export 'src/webhooks.dart';
