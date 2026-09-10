# Castor Alviar NHS — Document Tracking System

A ready-to-deploy website for tracking documents at Castor Alviar National High School:
staff log in to submit documents, route them between offices, print the school's actual
**Submission and Routing Slip** (with a Claim Stub), send a **Transmittal Slip** from the
Office of the Principal to concerned personnel by email, and send follow-up messages — and
anyone with a Document Control Number can check its status without logging in.

Whenever a document is logged, forwarded, or has its status changed, the system also tries
to email and SMS the document's owner (the person named on the slip) with the update, and
whenever the Principal sends a Transmittal Slip, the concerned personnel receive it by email
with the file attached. Both are optional — see **Turning on email and SMS notifications**
below — and the rest of the system works normally even if you never set them up.

This folder is a complete Netlify site:

- `public/index.html` — the whole application (one page, no build step).
- `netlify/functions/data.mjs` — the backend. It stores all data in **Netlify Blobs**
  (a small database included free with every Netlify site — nothing else to sign up for)
  and sends the email/SMS notifications described below.
- `netlify.toml` / `package.json` — tell Netlify how to build and run it.

## Deploy it (no coding required)

The easiest reliable path is GitHub + Netlify, because Netlify needs to run
`npm install` once to fetch the small library the backend uses — that only happens
automatically when Netlify builds from a Git repository (a plain drag-and-drop
upload skips that step).

**1. Put this folder on GitHub**
1. Go to [github.com](https://github.com) and sign in (or create a free account).
2. Click **New repository**, name it e.g. `canhs-dts`, keep it **Private** if you prefer, and click **Create repository**.
3. On the new repo's page, click **uploading an existing file**.
4. Drag in *everything inside this folder* (`public/`, `netlify/`, `netlify.toml`, `package.json`, this `README.md`) and click **Commit changes**.

**2. Connect it to Netlify**
1. Go to [app.netlify.com](https://app.netlify.com) and sign in (or create a free account).
2. Click **Add new site → Import an existing project**.
3. Choose **GitHub**, authorize it, and pick the `canhs-dts` repository.
4. Netlify will detect the settings from `netlify.toml` automatically (publish directory `public`, functions folder `netlify/functions`, build command `npm install`) — just click **Deploy**.
5. Wait about a minute for the first deploy to finish, then open the site link Netlify gives you (something like `https://canhs-dts.netlify.app`).

That's it — the site is live, and every visitor sees the same shared data.

**Optional:** In Netlify's site settings you can add a custom domain, rename the
`*.netlify.app` address, or invite a colleague as a Netlify collaborator so more than
one person can manage deploys.

## Using it

- The homepage is the public **Track a Document** page — no login needed.
- Click **Staff log in** and use the starter account: **Ruby B. Rodelas**, PIN **1234**.
- Once logged in, open **Offices & Staff** to add your real staff accounts and PINs,
  update the office list, fill in the school's real address/contact info, and set the
  **Principal's name and title** (used on the printed slips and the Transmittal Slip's
  signature line).
- A freshly deployed site starts **completely empty** — no sample or demo documents are
  seeded. The first document anyone submits becomes the first real record.
- **Tracking / Document Control Number** format is **`CANHS-yyyy-mm-001`** — a running
  number that starts fresh at `001` on the 1st of every month (e.g. `CANHS-2026-09-001`,
  `CANHS-2026-09-002`, …, then `CANHS-2026-10-001` on October 1st). It's generated
  automatically; nothing to configure.
- **Submit Documents** now matches the school's actual paper form: Document Owner,
  Contact No., Email Address, No. of folder/box/envelope, No. of pages, Document Type,
  Title, Destination, Action Needed (with an "Others" box for a custom action), and
  Submission Type. Submitting produces a **Submission and Routing Slip** — the same
  layout as the school's paper form — printed twice: the top copy for the office file,
  and a bottom copy labelled **CLAIM STUB** for the person following up, separated by a
  cut line.
- Forwarding a document or updating its status now also lets you check off the
  **Action Taken** (reviewed/approved, reviewed/for revision, incomplete attachment/return
  to owner, noted/for filing, or a custom note) that appears in the slip's Routing Details
  table — exactly like the checkboxes on the paper form.
- **Transmittal Slip** (visible to admin accounts) is for sending something from the
  Office of the Principal to specific personnel: tick the Department Head, Master Teacher,
  and/or SPC/Finance signatories (or fill in "Others"), tick the action(s) to be taken,
  optionally attach a file, and send. Each checked recipient with an email address gets an
  email with the document details (and the linked DTS number, if you selected one) and the
  attached file. A running list of everything sent, and whether each recipient's email went
  through, is shown below the form.
- Each signatory category (Department Head, Master Teacher, SPC/Finance) is seeded with the
  school's first three names in that role, matching the school's own limit of three
  signatories per category. To change who appears there later, ask for the personnel list
  to be updated in the code (`PERSONNEL_SEED` in `netlify/functions/data.mjs`) and redeploy —
  there's no in-app editor for the signatory directory yet.

## Turning on email and SMS notifications

Both are optional. Without them, the system works exactly as before — submitting, routing,
and sending transmittals all still succeed — the notification is just silently skipped.

**Email (SMTP, e.g. a Gmail or Google Workspace account)**

1. Turn on 2-Step Verification on the Google account you want to send from
   (myaccount.google.com → Security). If it's a Workspace account managed by the school's
   IT admin, they may need to enable "app passwords" for the account first (Admin console →
   Security → Authentication → 2-step verification → allow app passwords for the org unit).
2. Generate an **App Password**: myaccount.google.com → Security → 2-Step Verification →
   App passwords. Create one named e.g. "Castor Alviar DTS" and copy the 16-character code.
3. In Netlify: your site → **Site configuration → Environment variables → Add a variable**,
   and add:
   - `SMTP_HOST` = `smtp.gmail.com`
   - `SMTP_PORT` = `587`
   - `SMTP_USER` = the Gmail/Workspace address you're sending from
   - `SMTP_PASS` = the app password from step 2 (not the account's normal password)
   - `SMTP_FROM` = (optional) the "from" address shown to recipients, if different from `SMTP_USER`
4. Redeploy the site (Netlify → Deploys → Trigger deploy) so the new variables take effect.

**SMS (via [Semaphore](https://semaphore.co), a Philippine SMS gateway)**

1. Sign up at semaphore.co and load some SMS credits.
2. Copy your API key from the Semaphore dashboard.
3. In Netlify's environment variables, add:
   - `SEMAPHORE_API_KEY` = your API key
   - `SEMAPHORE_SENDER_NAME` = (optional) an approved sender name, if you've set one up
4. Redeploy the site.

If either is missing or misconfigured, the affected notification is skipped and reported
back to the admin as "not configured" — nothing else about the document or transmittal is
affected.

## A few honest notes

- **PINs are a convenience, not real security.** They gate the staff screens in the
  interface, but the backend does not enforce sessions or hash passwords — this suits a
  low-stakes internal tool, but don't use it for anything that needs strong access
  control without upgrading the login system first.
- **No real-time push.** Other staff's changes appear within about 15 seconds (the
  app polls the server on a timer) rather than instantly.
- **Netlify Blobs is simple, not transactional.** Two people editing the exact same
  document within the same second could rarely overwrite one part of each other's
  change (last write wins). Fine for normal office pace; not built for high concurrency.
- **Free tier limits.** Netlify's free plan comfortably covers a single school's usage
  (function calls, bandwidth, and Blobs storage). If usage grows a lot, check Netlify's
  current pricing.
- **Attachments are capped at about 4 MB.** That's a Netlify Function payload limit, not
  a setting you can raise — for a larger file, share a link instead (e.g. Google Drive)
  and mention it in the Remarks field.
- **Email/SMS notifications need the environment variables above.** Until they're set,
  every send is skipped (not queued or retried) and reported as "not configured" so staff
  know to follow up manually in the meantime.

## Troubleshooting: "Couldn't reach the server" / staff login doesn't work

If the site itself loads but logging in or submitting a document fails, the most common
causes, in order of likelihood:

1. **Project visibility is set to Private.** Site configuration → General → Visitor access.
   Set Production visibility to **Public** — otherwise Netlify blocks every visitor (staff
   included) before your own login screen ever runs.
2. **The repository structure doesn't match what Netlify expects.** `netlify.toml` says the
   site lives in `public/` and the backend function lives in `netlify/functions/` — if a
   browser upload flattened those folders (a common GitHub web-upload issue), Netlify can't
   find them. Check the repo on GitHub: you should see actual `public` and `netlify` folders,
   not loose files with the same names sitting at the top level.
3. **`MissingBlobsEnvironmentError` in the function logs** (Site → Logs → Functions → `data`).
   Netlify's automatic Netlify Blobs wiring is only reliable for functions written in the
   modern "v2" format (an ES module with `export default async (req, context) => {...}`,
   file extension `.mjs`) — the older `exports.handler = (event) => {...}` style can throw
   this error even when everything else is configured correctly. `netlify/functions/data.mjs`
   in this project already uses the v2 format specifically to avoid this.

## Updating the site later

Edit files in the GitHub repo (or push changes from your computer with `git`), and
Netlify redeploys automatically within a minute or two.

## Alternative: deploy from the command line

If you're comfortable with a terminal and have Node.js installed:

```bash
npm install -g netlify-cli
cd canhs-dts          # this folder
netlify login
netlify init           # follow the prompts to create/link a site
netlify deploy --prod
```

`netlify-cli` installs the dependencies and builds the function for you, so this works
even without GitHub.
