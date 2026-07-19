# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report them privately via GitHub's [**Report a vulnerability**](https://github.com/himanshu-systems/nats-studio/security/advisories/new) (Security → Advisories), or email **himanshuchavdacodes@gmail.com**. You'll get an acknowledgement as soon as possible, and we'll work with you on a fix and coordinated disclosure.

## Supported versions

NATS Studio is pre-1.0; security fixes land on `main` and in the next release. Please test against the latest release before reporting.

## Notes

- Connection credentials are stored in the OS keychain, never in plaintext config.
- Release binaries are **not yet code-signed**; verify you downloaded them from the official [Releases](https://github.com/himanshu-systems/nats-studio/releases) page.
