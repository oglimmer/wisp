# Signing & notarizing the macOS build

Everything here is done **once**, on a Mac, by hand. The result is five GitHub repository secrets
that `.github/workflows/release.yml` uses to produce a `.dmg` that opens without a Gatekeeper
warning. Until they exist, tagged builds still publish — as unsigned prereleases that need
`xattr -dr com.apple.quarantine` to open, and that the Homebrew cask deliberately ignores.

> **Do this in your own terminal, not through an AI session or any shared environment.** The `.p12`
> file and its password are a code-signing identity: anyone holding them can ship software as you.

## What you need first

- **Apple Developer Program membership** — $99/year, at
  [developer.apple.com/programs](https://developer.apple.com/programs/). A *free* Apple developer
  account cannot create the certificate this needs. Enrollment as an individual is usually approved
  within a day; enrolling as an organization additionally requires a D-U-N-S number and takes longer.
- **A Mac** — the private key is generated in its keychain and cannot be exported from anywhere else.
- **Two-factor authentication** on the Apple ID. Notarization requires it.
- Xcode or the Command Line Tools (`xcode-select --install`) for `codesign` / `notarytool`.

Budget 30–45 minutes, most of it waiting on Apple.

---

## Step 1 — Create the Developer ID Application certificate

You need the type called exactly **Developer ID Application**. This is the one for apps distributed
outside the Mac App Store. Do not use *Apple Development*, *Mac Developer*, or *Developer ID
Installer* (that last one is for `.pkg` installers) — Apple will reject notarization of a build
signed with the wrong type.

### Option A — let Xcode do it (fastest)

1. Xcode → **Settings…** → **Accounts** → **+** → sign in with your Apple ID.
2. Select the team → **Manage Certificates…**
3. Click **+** → **Developer ID Application**.

The **+** menu lists five similar-sounding options. Only *Developer ID Application* is right:
*Developer ID Installer* (directly below it) signs `.pkg` installers, which this project doesn't ship,
and *Apple Development* / *Apple Distribution* / *Mac Installer Distribution* are for local
development and App Store submission respectively.

Xcode generates the key pair and installs the certificate into your login keychain — on *this* Mac,
which is therefore the machine you must export the `.p12` from in step 2. A certificate listed as
**Not in Keychain** in this dialog has its private key on some other machine and is useless for CI.

### Option B — by hand, no Xcode

**Use this route if Xcode is signed in as a different Apple ID than the enrolled one**, or if several
accounts are signed in. Keychain Access has no notion of Apple accounts — it only makes a keypair —
and the certificate is issued by whichever account your *browser* is logged into, so the two never
have to agree.

1. Open **Keychain Access** → menu **Keychain Access** → **Certificate Assistant** → **Request a
   Certificate From a Certificate Authority…**
2. Fill in your email and a name. Leave *CA Email Address* empty. Choose **Saved to disk** and tick
   **Let me specify key pair information**. Continue.
3. Key size **2048 bits**, algorithm **RSA**. Save `CertificateSigningRequest.certSigningRequest`.
4. Go to [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates)
   → **+** → **Developer ID Application** → Continue.
5. When asked for a *Profile Type*, choose **G2 Sub-CA (Xcode 11.4.1 or later)**.
6. Upload the CSR, then download the resulting `developerID_application.cer`.
7. Double-click the `.cer` to install it. It pairs automatically with the private key created in
   step 3.

> Apple caps how many Developer ID Application certificates an account may hold (currently five),
> and they are account-wide rather than per-app. Don't revoke an existing one to make room unless you
> know nothing else is signing with it.

### Confirm it worked

```bash
security find-identity -v -p codesigning
```

You should see a line like:

```
1) A1B2C3… "Developer ID Application: Your Name (AB12CD34EF)"
```

The 10-character string in parentheses is your **Team ID**. Note it down.

---

## Step 2 — Export the identity as a `.p12`

CI has no keychain, so the certificate *and its private key* have to travel as an encrypted file.

1. **Keychain Access** → **login** keychain → **My Certificates** category.
2. Find **Developer ID Application: Your Name (TEAMID)**. Click the disclosure triangle — there must
   be a **private key** nested underneath it. If there isn't, the key lives on the Mac that generated
   the CSR and you have to export from that machine instead (or redo step 1 here).
3. Right-click the certificate → **Export "Developer ID Application: …"** → format
   **Personal Information Exchange (.p12)** → save as `wisp-signing.p12`.
4. Set a strong password when prompted. This becomes `MACOS_CERTIFICATE_PASSWORD`. It is not
   recoverable — store it in your password manager now.

Then base64-encode it, because GitHub secrets hold text:

```bash
base64 -i wisp-signing.p12 | tr -d '\n' > wisp-signing.p12.base64
```

The `tr -d '\n'` matters — a wrapped, multi-line value trips up some CI setups.

Check the password you chose actually opens the file, before it goes anywhere near CI:

```bash
openssl pkcs12 -in wisp-signing.p12 -nokeys -noout   # prompts for the password
```

Silence means it opened. `Mac verify error: invalid password?` means the password is wrong — and a
wrong or empty `MACOS_CERTIFICATE_PASSWORD` in the repo fails much later and far less clearly.

---

## Step 3 — Create an app-specific password for notarization

Notarization authenticates as your Apple ID, and your real password won't work.

Use the **enrolled** Apple ID — the one that owns the team from step 1. Apple checks that the Apple ID
belongs to the team behind `APPLE_TEAM_ID`, so credentials from a second account fail with a `401`
that reads like a wrong password.

1. Go to [appleid.apple.com](https://appleid.apple.com/) → **Sign-In and Security** →
   **App-Specific Passwords**.
2. **+**, name it something like `wisp-notarization`, and copy the generated
   `xxxx-xxxx-xxxx-xxxx` value. It is shown once.

Verify the three notarization credentials before trusting them to CI:

```bash
xcrun notarytool history \
  --apple-id "you@example.com" \
  --team-id "AB12CD34EF" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

An empty history is a success — it means Apple accepted the credentials. `401 Unauthorized` means the
password is wrong or that Apple ID isn't a member of the team.

---

## Step 4 — Put the five secrets in the repo

From your Mac, in the directory holding the base64 file:

```bash
gh secret set MACOS_CERTIFICATE --repo oglimmer/wisp < wisp-signing.p12.base64
gh secret set MACOS_CERTIFICATE_PASSWORD --repo oglimmer/wisp      # prompts, no shell history
gh secret set APPLE_ID --repo oglimmer/wisp
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo oglimmer/wisp
gh secret set APPLE_TEAM_ID --repo oglimmer/wisp
```

Prefer the prompting form over `--body "…"`, which would leave the value in your shell history. The
web UI at **Settings → Secrets and variables → Actions** works equally well.

| Secret | Value | Where it came from |
|--------|-------|--------------------|
| `MACOS_CERTIFICATE` | base64 of the `.p12` | step 2 |
| `MACOS_CERTIFICATE_PASSWORD` | the `.p12` export password | step 2 |
| `APPLE_ID` | the Apple ID email | your account |
| `APPLE_APP_SPECIFIC_PASSWORD` | `xxxx-xxxx-xxxx-xxxx` | step 3 |
| `APPLE_TEAM_ID` | 10-char team ID | step 1 |

Then delete the local copies you no longer need:

```bash
rm wisp-signing.p12.base64
```

Keep the `.p12` itself somewhere safe and offline — you'll want it when you set up another machine,
and re-creating it burns one of your certificate slots.

Confirm all five landed:

```bash
gh secret list --repo oglimmer/wisp
```

---

## Step 5 — Cut a signed release

```bash
npm version patch          # bumps package.json and creates the matching v… tag
git push --follow-tags
```

The workflow builds, signs with the hardened runtime and the entitlements in `build/`, submits to
Apple, staples the ticket, verifies with `codesign` / `spctl` / `stapler`, publishes the release, and
commits the `Casks/wisp.rb` bump. Notarization is usually under five minutes but Apple occasionally
takes 30.

Verify the published artifact on a Mac that never had the certificate installed:

```bash
brew upgrade --cask wisp || brew install --cask wisp
spctl --assess --type execute --verbose=4 /Applications/Wisp.app
```

`accepted / source=Notarized Developer ID` is the goal. If you can double-click the app with no
warning on a machine that has never run it before, it's done.

---

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `No identity found` / `skipped macOS application code signing` | `MACOS_CERTIFICATE` is empty, truncated, or not valid base64. Re-encode with the `tr -d '\n'` pipe. |
| Workflow warns `missing signing secrets` for a secret `gh secret list` shows | The secret exists but its value is empty — pressing Return at `gh secret set`'s hidden prompt stores an empty string just as happily as a real one. Set it again and watch for the confirmation line. |
| `The specified item could not be found in the keychain` | The `.p12` was exported without its private key. Redo step 2 and check for the nested key. |
| `Team is not yet configured for notarization` | Membership isn't fully active, or there are unsigned agreements — log into App Store Connect and accept any pending contracts. |
| `HTTP status code: 401` from notarytool | Wrong app-specific password, or the Apple ID isn't a member of the team whose ID you supplied. |
| `The binary is not signed with a valid Developer ID certificate` | Wrong certificate type — you need *Developer ID Application*, not *Apple Development*. |
| Notarization succeeds, app still warns | The ticket wasn't stapled, or the user is opening a build from before notarization. Check the `stapler validate` step in the workflow log. |
| Works locally, fails in CI | Local builds pick up your keychain via `CSC_IDENTITY_AUTO_DISCOVERY`; CI only has the secrets. Compare against the `Check signing secrets` step's output. |

### Renewal

Developer ID certificates last five years. Builds notarized before expiry keep working indefinitely
(Apple's timestamp covers them), but you cannot sign new ones — repeat steps 1, 2 and 4 when the time
comes. App-specific passwords do not expire, though they are invalidated if you change your Apple ID
password.

### Alternative: App Store Connect API key

Instead of an Apple ID plus app-specific password, notarization can authenticate with an API key
(`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) created under **Users and Access → Keys**
in App Store Connect. It's independent of any one person's Apple ID and can be revoked on its own,
which is nicer for a shared or long-lived project. Switching means replacing the three `APPLE_*`
notarization secrets in the workflow's signed-build step with those three variables; the certificate
half of the setup is unchanged.
