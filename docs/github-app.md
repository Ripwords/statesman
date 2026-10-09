# Connecting a GitHub App

Optional. Everything in the Variables tab works without it. The app adds one
thing: statesman can read the `variable` blocks in a repository's `.tf` files,
so each stored variable shows whether the configuration declares it.

## What it does, and what it does not

- **It only reads.** The app asks for Contents (read-only) and Metadata
  (read-only). statesman never writes to a repository, opens a pull request or
  posts a comment.
- **It reads `.tf` files in one directory.** It does not run Terraform, does not
  read `.tfvars` or state from the repository, and never sends variable values
  to GitHub.
- **It is optional.** With no app configured, GitHub routes answer 404 `GitHub
  is not configured on this deployment.` and the dashboard shows no repository
  panel on the Variables tab.
- **Every deployment registers its own app.** statesman is self-hosted, so there
  is no shared one.

## 1. Register the app

On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App**.
Use your organisation's settings instead if the repositories belong to one.

| Field                       | Value                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| GitHub App name             | anything unique, for example `statesman-acme`                      |
| Homepage URL                | your `BETTER_AUTH_URL`                                             |
| Setup URL | `<BETTER_AUTH_URL>/api/github/setup`, with **Redirect on update** left unticked |
| Webhook → Active            | ticked                                                             |
| Webhook URL                 | `<BETTER_AUTH_URL>/api/github/webhook`                             |
| Webhook secret              | the output of `openssl rand -hex 32`                               |
| Repository permissions      | **Contents: Read-only**, **Metadata: Read-only**. Nothing else.    |
| Subscribe to events         | **Push**                                                           |
| Where can this app be installed | **Only on this account**                                       |

Leave **Redirect on update** unticked. statesman's setup callback only accepts a
redirect it started itself (it checks a state cookie), so a redirect that GitHub
initiates after an update would land on the `The install link expired or did not
start here. Try Connect GitHub again.` error. Installation and repository
changes still reach statesman through webhooks.

Keep the webhook secret: it becomes `GITHUB_APP_WEBHOOK_SECRET`. GitHub also
delivers `installation` and `installation_repositories` events to every app
without a subscription, and statesman handles them (see
[Connect GitHub](#4-connect-github) and
[Uninstalling and revoking access](#uninstalling-and-revoking-access)).

## 2. Generate the private key

On the app's page, under **Private keys**, choose **Generate a private key**.
GitHub downloads a `.pem` file. Its contents become `GITHUB_APP_PRIVATE_KEY`:

- In a `.env` file you may keep the key on several lines, inside double quotes.
- On a hosting panel or in a compose env file, put it on one line and write the
  line breaks as `\n`. statesman turns each `\n` back into a line break.

## 3. Set the four variables

| Variable                    | Where to find it                                         |
| --------------------------- | -------------------------------------------------------- |
| `GITHUB_APP_ID`             | **App ID** on the app's page                             |
| `GITHUB_APP_SLUG`           | the last part of `https://github.com/apps/<slug>`        |
| `GITHUB_APP_PRIVATE_KEY`    | the `.pem` file from step 2                              |
| `GITHUB_APP_WEBHOOK_SECRET` | the secret from step 1                                   |

Set **all four or none**. A partial set is almost always a half-finished setup,
and running with GitHub quietly off would hide that, so the server refuses to
start and names what is missing:

```
GitHub App configuration is incomplete. Set all four or none; missing: GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET
```

Empty values count as unset. Restart the server after changing them.

## 4. Connect GitHub

A deployment connects **one** GitHub account: the app is registered with
**Only on this account**, so it can be installed on the user or organisation
that owns it and nowhere else.

An admin opens a project's **Variables** tab. The repository panel shows
**Connect GitHub** while no installation is recorded. It sends the browser to
GitHub to install the app and choose which repositories it may see. Only
**Connect GitHub** is admin-only: once the app is installed, linking an
environment to a repository is open to the project's owners as well as admins.

statesman records the installation in either of two ways, whichever arrives
first. Both are safe to repeat:

- **The `installation` webhook.** GitHub sends it to the Webhook URL when the
  app is installed (`created`), unsuspended (`unsuspend`), or when an owner
  accepts new permissions (`new_permissions_accepted`). The delivery is signed
  with the webhook secret, so it needs no session. statesman records the
  installation and its account name, and writes `github.install` to the audit
  log the first time.
- **The Setup URL redirect.** When the admin who pressed **Connect GitHub**
  completes the install in the same browser, GitHub sends them back through the
  Setup URL. statesman asks GitHub whether that installation exists and
  belongs to this app, records it, audits `github.install` with the admin as
  the actor, and lands on the project list with a **GitHub Connected** notice.

**When an organisation owner has to approve the install.** If the admin is not
an owner of the organisation, GitHub turns the install into a request. The
admin lands on the project list with an **Installation Requested** notice;
nothing is recorded yet. Once an owner approves the request on GitHub, GitHub
sends the `installation` webhook and statesman records it. Reload the
Variables tab and the panel offers **Link repository**. The owner does not need
a statesman account. GitHub may also send the owner to the Setup URL after
approving; without a statesman session that page answers `Sign in required`,
which is harmless, because the webhook has already done the work.

If the panel still shows **Connect GitHub** after an approval, the webhook did
not arrive. Open the app's **Advanced → Recent Deliveries** page, find the
`installation` delivery and redeliver it (see [Verify it](#7-verify-it)).

The button asks for a fresh install link each time. The link expires after ten
minutes, and it only works in the browser that started it.

## 5. Link a repository

With an installation recorded, the same panel shows **Link repository** (project
owners and admins). Fill in:

- **GitHub Account**: shown only when more than one installation exists.
- **Repository**: any repository the installation can see.
- **Branch**: leave empty to use the repository's default branch at the time
  of linking. statesman stores that branch's name, so if the default branch
  changes on GitHub later, the link keeps the old one. Link again to switch.
- **Directory**: the folder that holds the root module, for example
  `envs/prod`. Leave empty for the repository root. It may not contain `.` or
  `..` segments.

Only `.tf` files directly in that directory are read. **Subdirectories are not
read**, because a child module's variables are not inputs to the root module.
Link one environment per root module.

Saving runs the first sync straight away. After that, the panel shows the
repository, branch and directory, when it last synced, and an error banner if
the last sync failed. **Sync now** repeats a sync by hand and **Unlink** stops
it; stored values stay, and the declared set is removed until you link again.
The commit that was read is under **Technical details**.

## 6. How a push becomes a sync

A push to a linked repository and branch re-syncs **every** environment linked
to that pair. The webhook route:

- answers **202** with the number of environments it synced;
- syncs the environments one after another, and one environment's failure does
  not stop the others (it is logged on the server);
- ignores pushes to tags, other branches nobody linked, and **branch
  deletions**;
- answers **401** when the signature does not match the webhook secret, and
  **400** when the body is not a valid delivery.

There is no polling. A sync that finds a problem in the `.tf` files records it
on the link and leaves the previous declared set alone, so one bad push does not
mark every variable as undeclared.

**GitHub does not retry a failed webhook delivery on its own.** If a delivery
failed, redeliver it from the app's **Advanced → Recent Deliveries** page, or
press **Sync now** on the environment.

## 7. Verify it

Push a commit to a linked branch, then open the app's **Advanced → Recent
Deliveries** page on GitHub. The delivery should show **202**.

- **401**: the secret in the app and `GITHUB_APP_WEBHOOK_SECRET` differ. Copy
  the secret again, with no trailing space or newline, and redeliver.
- **404**: the deployment has no GitHub App configured, or the Webhook URL points
  at the wrong host.
- **Connection errors or timeouts**: GitHub cannot reach `BETTER_AUTH_URL`. A
  deployment on a private network needs a public route to
  `/api/github/webhook`.

## Uninstalling and revoking access

GitHub sends these two events whether or not the app subscribes to them:

- **The app is uninstalled** (`installation` with action `deleted`). statesman
  removes the installation, and every repository link that used it goes with it.
  Stored variables are untouched. The removal is recorded in the audit log as
  `github.uninstall`.
- **Repositories are removed from the installation**
  (`installation_repositories` with action `removed`). The links to those
  repositories stay, so access can be granted back, and each shows `The GitHub
  App no longer has access to this repository.` until a sync succeeds again.

## Troubleshooting

A failed sync shows under **The last sync failed** on the Variables tab. The
text is stored on the link, so it stays until the next successful sync.

| Message                                                           | Cause                                                                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitHub 404: Not Found` (or another GitHub 404) | The directory or the repository does not exist, or the app cannot see it. Check the directory, then the installation's repository list. |
| `GitHub 422: …` | GitHub's usual answer for a branch that does not exist. Check the Branch field. |
| `GitHub <status>: …` | Any other GitHub answer, including 5xx. Read the text after the status. |
| `GitHub 403: …`                                                   | GitHub refused the request: Contents or Metadata permission missing, or a rate limit. Read the text after the status.                                       |
| `GitHub 401: …`                                                   | GitHub rejected the app's own credentials: a wrong `GITHUB_APP_ID`, or a private key that does not belong to that app. statesman also drops its cached installation token on a 401, so if the token was revoked, the next sync uses a fresh one.                                       |
| `No .tf files in <directory> at <branch>.` | The directory exists but holds no `.tf` file directly inside it. When the Directory field is empty the message reads `No .tf files in the repository root at <branch>.` Check the directory, or whether the files live in a subdirectory (which is not read). |
| `<directory> is a file, not a directory`                          | The Directory field names a file. Point it at the folder.                                                                                                   |
| `variable "x" is declared in a.tf and b.tf`                       | Two files in the directory declare the same variable. Terraform would refuse this too. Remove one.                                                          |
| `variable "x" is declared twice in main.tf` | One file declares the same variable twice. Terraform would refuse this too. Remove one. |
| `<file>:<line>: syntax error`                                     | A `.tf` file does not parse. The other messages of this form, for example `attributes must be on separate lines` or `templates are not allowed in a variables file`, name the file and line in the same way. |
| `Could not reach GitHub.` | The request to GitHub failed before an answer arrived: DNS, a firewall, or GitHub being down. Check that the server can reach `api.github.com`, then press **Sync now**. |
| `GitHub did not answer in time.` | GitHub took longer than ten seconds to answer. Press **Sync now**. |
| `GitHub sent an unexpected response.` | GitHub answered, but not with the data statesman reads. Usually transient; press **Sync now**. |
| `The GitHub App private key could not sign a request. Check GITHUB_APP_PRIVATE_KEY.` | `GITHUB_APP_PRIVATE_KEY` is not a valid PEM private key, for example with its line breaks lost. See [step 2](#2-generate-the-private-key). |
| `The repository link changed during the sync.`                    | An owner or admin relinked the environment while a sync was running. The result was dropped so it could not land on the new link. Press **Sync now**.               |
| `The GitHub App no longer has access to this repository.`         | The repository was removed from the installation. Add it back under the installation's settings on GitHub, then press **Sync now**.                         |

**Sync now** on an environment with no link answers 404 `This environment is not linked to a repository.` That is not stored on a link; the panel shows it as the action error. Link a repository first.

A failure to reach GitHub is stored on the link like any other sync failure.
statesman waits ten seconds for each GitHub request before giving up.

If the first sync after **Link repository** fails for a reason that is not
GitHub's or the `.tf` files' (for example the server's parser failing to load),
the link is still saved and the form shows `Linked. The first sync failed: The
first sync could not finish. Press Sync now to try again.` The server log has
the cause.

Messages from the dashboard's own GitHub routes are fixed, so raw GitHub text
never reaches the page:

| Message                                                                   | Cause                                                                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GitHub could not find that installation or repository.`                  | GitHub answered 404. The installation was removed or the repository is no longer shared. |
| `GitHub refused access. Check the app permissions and installation.`      | GitHub answered 403.                                                                    |
| `GitHub returned an error. Try again.`                                    | Any other GitHub failure.                                                               |
| `The GitHub App cannot see that repository.`                              | The repository you picked is not in the installation's list.                            |
| `Unknown installation.`                                                   | The installation is not one this deployment recorded.                                   |
| `The install link expired or did not start here. Try Connect GitHub again.` | The state cookie is missing or differs: the link is older than ten minutes, or it was opened in another browser. |
| `GitHub did not send an installation id.`                                 | The Setup URL was opened without `installation_id`.                                     |
| `The directory may not contain . or .. segments.`                         | The Directory field has a `.` or `..` part.                                             |
| `GitHub is not configured on this deployment.`                            | The four `GITHUB_APP_*` variables are unset.                                            |
