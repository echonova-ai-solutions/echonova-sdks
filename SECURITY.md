# Security policy

## Reporting a vulnerability

**Please don't report security problems in public issues, pull requests or discussions.**

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to the [private reporting form](https://github.com/echonova-ai-solutions/echonova-sdks/security/advisories/new). Only you and the maintainers can see the report.

Please include:

- the SDK (Python, JavaScript/TypeScript, Dart/Flutter, a reference proxy, or a tool in this repository) and its version;
- the runtime and its version, and the operating system;
- what the problem is and what an attacker could do with it;
- the steps or code to reproduce it, ideally the smallest example that shows it;
- the request ID (the `X-Request-Id` response header, or `request_id` / `requestId` on the SDK's error) if an API call is involved.

**Never include a working API key or webhook secret in a report.** If a key is needed to reproduce the problem, use a test key and delete it afterwards. We will never ask you for your keys.

We'll acknowledge your report, keep you updated while we investigate and fix it, and agree with you on when to disclose it. If you wish, we'll credit you in the security advisory.

### What to report here

Vulnerabilities in the code in this repository, for example:

- an API key or webhook secret that reaches logs, error messages, `repr()` output or another host;
- webhook signature checks that can be bypassed;
- the browser guard or proxy mode exposing a key to a user's device;
- a reference proxy that can be used as an open proxy, or that leaks its key;
- a problem in how packages are built or published.

A problem in the EchoNova service itself, not in the SDKs, can be reported through the same channel. We'll pass it to the right team.

## Supported versions

Security fixes are released as patch releases on the latest minor version of each SDK's current major version. Upgrading within a major version is safe: it contains no breaking changes, under [Semantic Versioning](https://semver.org/).

| SDK | Package | Supported |
| --- | --- | --- |
| Python | `echonova-ai` on PyPI | latest minor of the current major |
| JavaScript/TypeScript | `@echonova/ai` on npm | latest minor of the current major |
| Dart/Flutter | `echonova_ai` on pub.dev | latest minor of the current major |

- Before `1.0.0`, only the latest pre-release is supported. Betas (`0.9.x`) get fixes in a new beta, not in older ones.
- When a new major version ships, its release notes say how long the previous major will receive security fixes.
- The SDKs support only language and runtime versions that are still maintained upstream (see [ADR 0009](docs/adr/0009-runtime-support-policy.md)). A vulnerability that exists only on an unsupported runtime may not be fixed.

Releases are published only from this repository's GitHub Actions workflows, using OIDC trusted publishing with provenance (PyPI attestations, npm provenance). No long-lived publishing tokens exist. You can use the registry's tools to check that a package was built from this repository.

## Handling API keys

An EchoNova API key spends your workspace's credits. Treat it like a password.

- **Keep keys on your server.** Never put a key in a web page, a mobile or desktop app, or any other code that runs on a user's device. Anything shipped to a device can be extracted.
- **For browsers and Flutter apps, use proxy mode.** The app talks to your backend with its own user authentication, and your backend adds the key. See [ADR 0008](docs/adr/0008-keys-stay-on-servers.md) and the reference proxies in `proxy-examples/`.
- **Read keys from the environment or a secrets manager.** The SDKs read `ECHONOVA_API_KEY` by default. Don't hard-code keys, and don't commit them, including in `.env` files.
- **Limit what each key can do.** Use a separate key for each application and environment, give it access only to the services it needs, and set a Credit Limit on it.
- **Rotate keys** regularly, and immediately if one may have been exposed: create a new key in the EchoNova portal, deploy it, then delete the old one.
- **Treat webhook secrets the same way.** Verify every webhook request with the SDK's verify helper, against the raw request body.

What the SDKs do to protect keys:

- The key is sent only to the configured EchoNova API origin, never to the storage host behind a signed download link.
- Keys are redacted in `repr()` output and error messages. Logs never contain the `Authorization` header, request or response bodies, the query string of signed links, or webhook secrets.
- The JavaScript SDK refuses to use an API key in a browser unless you opt in explicitly with `dangerouslyAllowBrowser`.

If you find a key that isn't yours, for example in an issue or a public repository, report it privately as described above.
