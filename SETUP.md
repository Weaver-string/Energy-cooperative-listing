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

The app is now deployable as a single Node web service: it serves the website, stores profile/account requests, sends verification emails, and publishes approved profiles.

Recommended free stack:

- Render free web service for the website and backend.
- Supabase or Neon free Postgres for persistent profile/account data.
- Resend free tier for approval emails.

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
ADMIN_TOKEN=long_random_admin_secret
```

`PUBLIC_BASE_URL` must be the final public URL of the hosted site. Approval links in emails use this value.
Render can generate `ADMIN_TOKEN` from `render.yaml`; use it only when calling protected admin endpoints.

Do not rely on local JSON files for a permanent hosted site. Hosted services can redeploy or restart, so persistent online data should use `DATABASE_URL`.

## Email And Approval Flow

1. A co-op requests listing access.
2. You receive an email at `keyse00ali@gmail.com`.
3. The co-op submits its profile draft.
4. You receive a profile review email with an approval link.
5. Opening the approval link marks the account as verified and publishes the profile online.

## Authentication

Energy Agora uses its own backend auth flow. Keep Neon Auth turned off unless you intentionally decide to rebuild login around Neon later.

- Passwords are stored as salted `scrypt` hashes.
- Login state is stored in server-side sessions.
- Browsers receive an HttpOnly `ea_session` cookie, not account data in localStorage.
- Profile submission requires a valid session cookie.
- New accounts remain `Pending manual review` until you approve them from the email link.
- State-changing requests check the browser origin to reduce CSRF risk.

## Useful Endpoints

```text
GET  /health
GET  /api/cooperatives
POST /api/auth/request-access
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/session
POST /api/profiles
GET  /api/listing-requests?adminToken=...
GET  /api/listing-requests/:id/approve?token=...
```



