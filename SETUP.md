# Energy Agora Setup

## Run Locally

```powershell
npm start
```

Open:

```text
http://localhost:4173
```

Without `RESEND_API_KEY`, notification emails are saved under `data/outbox/` so you can still test the approval links locally. Without `DATABASE_URL`, local data is saved under `data/`.

## Make It Accessible Online

The app is now deployable as a single Node web service: it serves the website, stores profile/account requests, sends private review emails, handles password resets, and publishes approved profiles.

Recommended no-card stack:

- Vercel Hobby for the website and serverless backend.
- Neon free Postgres for persistent profile/account data.
- Resend free tier for approval emails.

### Vercel

1. Push this repository to GitHub.
2. In Vercel, choose **Add New... Project**.
3. Import `Weaver-string/Energy-cooperative-listing`.
4. Leave the framework preset as **Other** if Vercel asks.
5. Add these environment variables:

```text
DATABASE_URL=postgresql://...
DATABASE_SSL=true
PUBLIC_BASE_URL=https://your-vercel-url.vercel.app
RESEND_API_KEY=your_resend_api_key
RESEND_FROM=Energy Agora <verified-sender@yourdomain.com>
ADMIN_VERIFICATION_EMAIL=keyse00ali@gmail.com
```

After the first deployment, copy the generated Vercel URL back into `PUBLIC_BASE_URL`, then redeploy. Approval links use this value.
Vercel requires `DATABASE_URL`; the serverless filesystem should not be used for account/profile data.
Resend is required on Vercel for real emails, including your private approval emails and user password reset links.

### Render

Render also works, but it may ask for a credit card. Use it only if you are comfortable with that.

1. Push this folder to a GitHub repository.
2. In Render, create a new Blueprint from that repository.
3. Render will read `render.yaml` and create the `energy-agora` web service.
4. Set these environment variables in Render:

```text
PUBLIC_BASE_URL=https://your-render-url.onrender.com
DATABASE_URL=postgresql://...
DATABASE_SSL=true
RESEND_API_KEY=your_resend_api_key
RESEND_FROM=Energy Agora <verified-sender@yourdomain.com>
ADMIN_VERIFICATION_EMAIL=keyse00ali@gmail.com
```

`PUBLIC_BASE_URL` must be the final public URL of the hosted site. Approval links in emails use this value.

Do not rely on local JSON files for a permanent hosted site. Hosted services can redeploy or restart, so persistent online data should use `DATABASE_URL`.

## Email And Approval Flow

1. A co-op requests listing access.
2. You receive an email at `keyse00ali@gmail.com`.
3. The co-op submits its profile draft.
4. You receive a profile review email with an approval link.
5. Opening the approval link marks the account as verified and publishes the profile online.

## Google Search

Energy Agora exposes `robots.txt`, `sitemap.xml`, homepage metadata, and crawlable public co-op profile pages at `/coops/:id`.

After deployment, submit this sitemap in Google Search Console:

```text
https://energy-cooperative-listing.vercel.app/sitemap.xml
```

If you add a custom domain later, update `PUBLIC_BASE_URL`, redeploy, and submit the new domain sitemap.

## Authentication

Energy Agora uses its own backend auth flow. Keep Neon Auth turned off unless you intentionally decide to rebuild login around Neon later.

- Passwords are stored as salted `scrypt` hashes.
- Login state is stored in server-side sessions.
- Browsers receive an HttpOnly `ea_session` cookie, not account data in localStorage.
- Sessions are long-lived and refreshed when the app loads, so co-ops stay logged in unless they sign out or clear browser cookies.
- Profile submission requires a valid session cookie.
- New accounts remain `Pending manual review` until you approve them from the email link.
- Login, signup, and password reset requests are rate limited.
- Password reset links are emailed privately and expire after 30 minutes.
- State-changing requests check the browser origin to reduce CSRF risk.

## Useful Endpoints

```text
GET  /health
GET  /api/health
GET  /api/cooperatives
POST /api/auth/request-access
POST /api/auth/login
POST /api/auth/request-password-reset
POST /api/auth/reset-password
POST /api/auth/logout
GET  /api/auth/session
POST /api/profiles
GET  /api/listing-requests/:id/approve?token=...
```



