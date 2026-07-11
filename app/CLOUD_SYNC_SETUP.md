# Setting up cloud sync (Google Drive + GitHub Pages)

Cloud sync is optional — the app works exactly as before without it. This is a one-time setup, done in two places: GitHub (to host the app at a real URL) and Google Cloud Console (to let the app talk to your Drive). Both need your own accounts; I can't do these steps for you.

## 1. Host the app on GitHub Pages

1. Create a new GitHub repository (public or private both work) and push this project to it — the workflow at `.github/workflows/pages.yml` is already set up to deploy the `app/` folder automatically on every push to `main`.
2. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions** (not "Deploy from a branch").
3. Push to `main` (or re-run the workflow from the **Actions** tab). After it finishes, your app is live at `https://<your-username>.github.io/<repo-name>/`.

Note the exact origin (scheme + host, no path) — you'll need it in step 2.4 below. For a repo named `FinTrack` owned by `you`, the origin is `https://you.github.io` (GitHub Pages origins don't include the repo name — origin matching only looks at scheme/host/port).

## 2. Create a Google OAuth Client ID

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a new project (or pick an existing one) — name doesn't matter, e.g. "FinTrack".
2. Go to **APIs & Services → OAuth consent screen**.
   - User type: **External**.
   - App name: "FinTrack", User support email and Developer contact: your email.
   - **Publishing status: keep it on "Testing"** — do not click "Publish App". Testing mode skips Google's verification review entirely, which is fine since you're the only user.
   - Under **Test users**, click **Add users** and add your own Google account email. Only emails on this list can sign in while in Testing mode (capped at 100 users, but you only need one).
3. Go to **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name: e.g. "FinTrack Web".
   - **Authorized JavaScript origins** — add both of these (no trailing slash, no path):
     - `http://localhost:8000` (or whatever port you use for local testing — see step 3 below)
     - `https://<your-username>.github.io` (your real GitHub Pages origin from step 1)
   - Leave **Authorized redirect URIs** empty — not needed for this flow.
   - Click **Create**. Copy the Client ID that looks like `123456789-abc...apps.googleusercontent.com`.

## 3. Paste the Client ID into the app

Open `app/drive-sync.js` and replace the placeholder near the top:

```js
const CLIENT_ID = "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com";
```

with your real Client ID, then commit and push. (This value isn't a secret by itself — it identifies your app to Google, but it can't be used to access anything without also passing your origin allow-list and the narrow `drive.file` permission scope, which is the actual security boundary.)

To test locally before pushing, serve the `app/` folder over HTTP (not by double-clicking `index.html` — Google sign-in doesn't work over `file://`):

```
cd app
python3 -m http.server 8000
```

then open `http://localhost:8000` in a browser.

## 4. Sign in

Open the live (or local) URL, click **Sign in with Google** in the header, and approve access. The first time, if you already have data both on this device and (from a previous sign-in) in Drive, it'll ask which one to keep. After that, edits sync automatically a couple of seconds after you stop typing, and a small badge in the header shows **Saving…** / **Synced** / **Offline — will sync when reconnected**.

## Troubleshooting

- **"Origin mismatch" / sign-in popup fails immediately**: the page's URL doesn't exactly match one of the Authorized JavaScript origins in step 2.4. Double-check scheme (`https` vs `http`) and that there's no trailing slash or path in the console setting.
- **"Access blocked: FinTrack has not completed Google verification"**: your Google account isn't in the Test users list from step 2.2 — add it there.
- **Sign-in button is greyed out**: you're opening `index.html` directly as a local file. Cloud sync only works when the app is served over `http(s)` — either the local dev server (step 3) or the live GitHub Pages URL.
- **Signed in yesterday, asked to sign in again today**: Google access tokens last about an hour and refresh silently while your browser has an active Google session; if that session itself expired (e.g. you signed out of Google entirely, or it's been a long time), you'll need to click Sign in again. Your data is never lost either way — it's always in `localStorage` on this device regardless of sync state.
