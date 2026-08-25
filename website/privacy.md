# Privacy Policy — NATS Studio

Short version: NATS Studio collects nothing about you. There is no telemetry, no analytics, no crash reporting, and no account. This page explains exactly what that means.

## What the application collects

Nothing. NATS Studio does not collect, transmit, or store any personal data, usage data, or diagnostic data about you or how you use it. There is no analytics SDK, no crash reporter, no telemetry endpoint, and no "anonymous usage statistics" toggle, because there is nothing to toggle.

The application has no user accounts, no sign-in, and no license activation. You download it, run it, and it works. Nothing is registered anywhere.

## What is stored on your machine

NATS Studio stores its configuration locally, in your operating system's standard application-data directory. This includes your saved connection profiles (server URLs, TLS settings, and monitoring URLs), saved request and publish templates, and interface preferences such as your theme choice.

**Connection credentials — passwords, tokens, and NKey seeds — are stored in your operating system's keychain** (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux), never in plaintext configuration files. Message sessions you record and save are written only to the file location you choose, when you choose to save them.

All of this data stays on your computer. Deleting the application's data directory removes it.

## What leaves your machine

Two things, both of which you control:

- **Your NATS servers.** The application connects to whichever NATS servers you configure, and exchanges exactly the messages and management commands you ask it to. That traffic goes to your infrastructure — never through any server operated by this project.
- **Update checks.** The application periodically checks GitHub for a newer release. That request tells GitHub your IP address and the current version, the same as any download would; it is handled under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). No identifier for you or your installation is sent.

There are no other outbound connections. The application does not phone home.

## This website

The nats.studio website is a set of static files hosted on GitHub Pages. It sets no cookies, runs no analytics, and embeds no tracking pixels or third-party advertising scripts. The only third-party request the page makes is to Google Fonts to load its typeface, which is subject to [Google's privacy policy](https://policies.google.com/privacy).

As with any web host, GitHub processes standard server request logs (including IP addresses) to serve the site — see [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). This project neither receives nor has access to those logs.

## Verifying any of this

NATS Studio is MIT-licensed open source. Every claim on this page can be checked against the source code at <https://github.com/himanshu-systems/nats-studio> — you do not have to take it on trust, and you can build the application from source yourself if you prefer.

Questions about privacy, or corrections to this page, can go to <himanshu.tech.profile@gmail.com>. If this policy ever changes materially, the change will be noted in the project changelog.
