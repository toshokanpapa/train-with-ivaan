# Ivaan — your own copy

This is a working, self-contained version of Ivaan, built from the protocol
and architecture documents. It's yours to deploy independently of Michael's
build — a backup, a testing space, or the link for the workshop if it comes
to that.

No terminal or coding required. Two accounts, both free: **GitHub** and
**Vercel**. If you already have a GitHub account, skip to step 2.

## 1. Create a GitHub account (if you don't have one)

Go to github.com and sign up. Takes about a minute.

## 2. Create a new repository

- Click the **+** in the top right of github.com, then **New repository**.
- Name it `ivaan` (or anything you like).
- Leave it **Public** or **Private** — either works for what we're doing.
- Do **not** check "Add a README" — we're about to upload our own files.
- Click **Create repository**.

## 3. Upload the files

You'll land on a page with a link that says **uploading an existing file**
— click it. (If you don't see that link, look for **Add file → Upload
files** near the top right.)

Now, on your computer, open the folder this README is sitting in. Select
**everything inside it** (all the files and folders — `app`, `lib`,
`package.json`, and so on) and drag the whole selection into the browser
window where GitHub says "Drag files here."

Wait for the upload to finish, then scroll down and click **Commit changes**.

A couple of things to double check once it's uploaded:
- You should see folders named `app` and `lib` in the repository, not just
  loose files. If everything landed as one long flat list instead, the
  folder structure didn't come through — delete what uploaded and try
  again, this time dragging the folder itself rather than files one at a
  time.
- The `.env.example` file should be there, but **you should never upload a
  real `.env` file with your actual key in it** — we'll add the real key
  somewhere safer in step 5.

## 4. Get an Anthropic API key

- Go to console.anthropic.com and sign in (or create an account).
- Find **API Keys** in the left-hand menu, click **Create Key**, give it any
  name, and copy the key it shows you. You won't be able to see it again
  after you leave that page, so paste it somewhere temporary if you need a
  moment.
- This account will need a small amount of credit loaded for Ivaan to
  actually respond — a few dollars is enough for a great deal of testing
  and the workshop itself.

## 5. Deploy on Vercel

- Go to vercel.com and sign up using your **GitHub account** (there's a
  "Continue with GitHub" button — use that one, it links the two
  automatically).
- Click **Add New… → Project**.
- Find your `ivaan` repository in the list and click **Import**.
- Vercel will recognize it as a Next.js app automatically. Before clicking
  Deploy, look for **Environment Variables** and add one:
  - Name: `ANTHROPIC_API_KEY`
  - Value: the key you copied in step 4
- Click **Deploy**.

Vercel will build the app — this takes a minute or two — and then hand you
a live link, something like `ivaan-yourname.vercel.app`. That link works
immediately, for anyone, no sign-in required on their end.

## 6. Test it

Open the link. Say something back and forth with Ivaan. Try refreshing the
page mid-conversation — it should pick up where you left off, since the
conversation lives in your browser's own memory for that tab. Try the
**Download conversation** button.

## If something goes wrong

- **A reply hangs for a while and then fails ("failed to fetch" or "taking
  longer than expected"):** this build already raises Vercel's function
  timeout to 60 seconds (the free-tier maximum), which should cover the
  large majority of replies. If you still see this occasionally, a "Try
  again" button will appear — nothing you wrote is lost, and clicking it
  resends the same turn. If it happens often, it usually means individual
  replies are running long; shortening `max_tokens` in
  `app/api/chat/route.js`, or upgrading the Vercel project to the Pro tier
  (which allows much longer function times), both help.
- **Build fails on Vercel:** click into the failed deployment and read the
  error at the bottom — it's usually a typo introduced during upload
  (a file that didn't come through, or landed in the wrong folder). Compare
  against the file list below and re-upload what's missing.
- **The page loads but Ivaan never responds:** almost always the API key —
  double-check it was pasted correctly into Vercel's Environment Variables
  (Project → Settings → Environment Variables), and that the Anthropic
  account has credit loaded.
- **You want to change something later** (wording in Ivaan's instructions,
  colors, anything): edit the file directly on GitHub's website — open the
  file, click the pencil icon, make your change, commit. Vercel redeploys
  automatically within a minute or two of any commit.

## What's in this folder

```
app/
  page.js          the conversation itself (what the user sees)
  layout.js         page wrapper
  globals.css        styling
  api/chat/route.js  talks to Claude; no dataset, no storage
lib/
  ivaan-prompt.js    Ivaan's full instructions — persona, tone, guardrails
package.json         what to install
.env.example          reminder of what env var Vercel needs
```

If you ever want to hand this to Michael to fold into the main site instead
of running it separately, `lib/ivaan-prompt.js` and `app/api/chat/route.js`
are the two files that matter most — everything else is just the interface
around them.
