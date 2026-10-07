# Security Policy

## Supported versions

Pre-1.0. Only the latest release is supported; fixes land on `main` and ship in the next patch.

## Reporting a vulnerability

Report privately — **not** in a public issue:

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  on this repository, or
- email the maintainer address in the repository's `package.json`.

Include the version, a reproduction, and what you believe the impact is. Expect an acknowledgement
within a few days. Please allow a fix and a release before publishing.

## What this project holds

A **provider credential**. That is the security-relevant asset: a leaked key is billable. Treat
anything that discloses one as high severity.

## Invariants this project maintains

These are enforced, not aspirational:

- **A credential value is never echoed.** A credential failure raises `MISSING_CREDENTIAL`, naming the
  setting that is unset. Neither the error, nor a log line, nor a test fixture carries a value.
- **Credentials are supplied by the composition** as a validated config field
  (`apiKey: !!js process.env.OPENAI_LIVE_API_KEY`), never read from a key file in code and never
  packaged. This is a harness-wide convention, not a local preference.
- **`.gitignore` was committed before the first tracked file**, so `.env`, `*.credentials.yaml`,
  `secrets/`, `*.pem` and `*.key` cannot be added by accident.
- **The full git history is secret-scanned in CI**, as the first step — a secret removed in a later
  commit is still published, so scanning the working tree is not enough.
- **The published tarball is inspected before publication** for anything that should not ship.

## Scope

In scope: the packages in this repository, their published artifacts, and the bundle patch.

Out of scope: the DeepSeek Harness itself, the OpenAI live API, and the security of a user's own
provider account, key handling, or spend limits — report those to the relevant vendor.
