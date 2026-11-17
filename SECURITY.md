# Security Policy

This project follows a coordinated vulnerability disclosure policy, adapted from
[IdleCodeRedeemer](https://github.com/BigMichi1/IdleCodeRedeemer/blob/main/SECURITY.md).

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private vulnerability
reporting instead:

1. Open the [Security tab](https://github.com/BigMichi1/minecraft-cards/security) of this
   repository.
2. Choose **Report a vulnerability**.
3. Describe the problem and submit.

Please include:

- what the vulnerability is and what an attacker gains (for example a leaked Discord token, an
  eBay secret, another user's missing list, or code execution in the bot);
- how to reproduce it;
- the affected version or commit;
- a suggested fix, if you have one.

## What to expect

| Phase                | Target                                      |
| -------------------- | ------------------------------------------- |
| Acknowledgment       | within 3 business days                      |
| Assessment and plan  | within 10 business days                     |
| Fix                  | as soon as it is tested; severe ones first  |
| Public advisory      | after the fix is released, with your credit |

This is a small, single-maintainer project, so these are targets, not guarantees. Reports made
in good faith are handled confidentially until a fix is available, and reporters are credited in
the advisory unless they prefer not to be.

## Supported versions

Only the latest release and the `main` branch receive security fixes. The project is pre-1.0:
upgrade to the latest release.

## Out of scope

- Vulnerabilities in Discord, eBay, the shops or other third-party services (report them to
  the provider).
- Problems that need an already compromised server or a leaked `DISCORD_TOKEN`.
- Documentation or configuration mistakes, feature requests and ordinary bugs: open a regular
  issue.

## Security measures

- Secrets are never committed: Gitleaks runs as a pre-commit hook and, with TruffleHog, in CI.
  `DISCORD_TOKEN`, `EBAY_CLIENT_SECRET` and eBay access tokens are never logged.
- Dependencies are locked (`bun.lock`, installed frozen), watched by Dependabot, checked by
  dependency review and a daily `bun audit`; CodeQL and OpenSSF Scorecard run in CI.
- Changes to `main` go through pull requests with CODEOWNERS review; commits are signed off
  (DCO).
- Container images are built in CI, run as a non-root user, and release images are signed with
  Cosign (keyless). See `docs/deployment.md` and the release notes for `cosign verify`.

## For operators

- Keep `.env` out of version control and rotate the Discord token if it is ever exposed
  (Discord Developer Portal, **Bot** tab).
- Back up and restrict access to `data/cards.db`: it holds users' missing lists.
- Keep the bot private (**Public Bot** off) and `BOT_ADMIN_ID` set to the admin only.
