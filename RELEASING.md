# Releasing `@probabl/pi-skill-lifecycle`

How to publish a new version to npm.

Publishing runs in GitHub Actions using
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC), so
there is **no `NPM_TOKEN` secret** to create or rotate. The workflow file is
`.github/workflows/release.yml`.

## TL;DR

```sh
# 1. bump the version (updates package.json and package-lock.json)
npm version patch --no-git-tag-version

# 2. commit and push
git add package.json package-lock.json
git commit -m "Release 0.2.1"
git push origin main

# 3. create the GitHub Release whose tag matches the version
gh release create 0.2.1 --title "Release 0.2.1" --generate-notes
```

The Release triggers the `Release` workflow, which runs `npm ci`, `typecheck`,
tests, and `npm publish --provenance`. The package appears on npm with a
provenance attestation.

## One-time setup (already done — keep for reference / recovery)

- npm scope `@probabl` is provided by the `probabl` npm organization; the
  publishing account must be a member (owner/developer) with 2FA enabled.
- Each package has a **Trusted Publisher** configured (npmjs.com → package →
  Settings → Trusted Publisher → GitHub Actions):

  | Field | Value |
  |---|---|
  | Organization | `probabl-ai` |
  | Repository | `pi-skill-lifecycle` |
  | Workflow filename | `release.yml` |
  | Environment | *(blank)* |

  Equivalent CLI (needs npm ≥ 11.15 and 2FA):

  ```sh
  npm trust github @probabl/pi-skill-lifecycle \
    --repo probabl-ai/pi-skill-lifecycle --file release.yml --allow-publish
  ```

If you rename `release.yml`, update the workflow filename in the trusted
publisher too, otherwise OIDC publishing stops working.

## Remotes

| Remote | Points at | Use |
|---|---|---|
| `origin` | `probabl-ai/pi-skill-lifecycle` | where releases happen |
| `glemaitre` | `glemaitre/pi-skill-lifecycle` (personal fork) | optional; `git push glemaitre main` |

## Before you release

```sh
git switch main && git pull
npm ci
npm run typecheck
npm test
# optional, needs a Pi binary: PI_BIN=... npm run test:e2e
```

## Cutting a release

1. Bump the version. `npm version <patch|minor|major> --no-git-tag-version`
   updates both `package.json` and `package-lock.json`.
2. Commit and push to `main`.
3. Create a GitHub Release (UI: *Releases → Draft a new release*, or
   `gh release create <version> --generate-notes`). The tag must equal the
   `package.json` version; both `0.2.1` and `v0.2.1` are accepted. The workflow
   fails fast if the tag and version disagree.
4. Watch the run: `gh run list -R probabl-ai/pi-skill-lifecycle -w Release`.
5. Verify:

   ```sh
   npm view @probabl/pi-skill-lifecycle version
   pi -e npm:@probabl/pi-skill-lifecycle
   pi install npm:@probabl/pi-skill-lifecycle
   ```

   The published tarball only contains `extensions/`, `README.md`, and
   `LICENSE` (see the `files` field in `package.json`); tests and `scripts/`
   are intentionally not shipped.

## Publishing without a GitHub Release

*Actions → Release → Run workflow*. It defaults to a dry run; clear the
`dry_run` checkbox to publish the version currently in `package.json`. This is
also authorized by the same trusted publisher.

## Manual publish (fallback)

Only needed if Actions/OIDC is unavailable. Requires 2FA:

```sh
npm login
npm whoami
npm publish --access public      # prompts for a one-time password
```

## Troubleshooting

- **`You cannot publish over the previously published versions: X`** — the
  version already exists on npm. Bump `version` (and `package-lock.json`) and
  release again. This is also why the `dry_run` path can fail: `npm publish
  --dry-run` still checks the registry for the version.
- **`EOTP` / one-time password required** — 2FA is `auth-and-writes`. Authenticate
  via the browser URL the CLI prints, or pass `--otp=<code>`.
- **`npm view` returns 404 right after the first publish** — npm's package
  *index* (packument) can lag behind the version/tarball, which are already
  live. Wait (minutes to a few hours) and retry; do not republish the same
  version. If it persists, contact `support@npmjs.com` and note that the `PUT`
  returned 200 while the packument 404s.
- **Provenance/auth errors in CI** — confirm the trusted publisher's
  Organization/Repository/Workflow filename exactly match this repository and
  `release.yml`.
