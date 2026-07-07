const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const OUTBOX_DIR = path.join(DATA_DIR, "outbox");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const REQUESTS_FILE = path.join(DATA_DIR, "listing-requests.json");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const ADMIN_EMAIL = process.env.ADMIN_VERIFICATION_EMAIL || "keyse00ali@gmail.com";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Energy Agora <onboarding@resend.dev>";
const DATABASE_URL = process.env.DATABASE_URL || "";
const USE_DATABASE = Boolean(DATABASE_URL);
const SESSION_COOKIE = "ea_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const PASSWORD_RESET_MAX_AGE_MS = 1000 * 60 * 30;
let dbPool = null;
let storageReadyPromise = null;
const rateLimitBuckets = new Map();

const COLLECTIONS = {
  accounts: "accounts",
  requests: "listing-requests",
  profiles: "profiles",
  sessions: "sessions",
};

const COLLECTION_FILES = {
  [COLLECTIONS.accounts]: ACCOUNTS_FILE,
  [COLLECTIONS.requests]: REQUESTS_FILE,
  [COLLECTIONS.profiles]: PROFILES_FILE,
  [COLLECTIONS.sessions]: SESSIONS_FILE,
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer(handleRequest);

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, PUBLIC_BASE_URL);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (isStateChangingRequest(req) && !isTrustedOrigin(req)) {
      sendJson(res, 403, { error: "Request origin is not allowed." });
      return;
    }

    if (requiresStorage(url.pathname)) {
      await ensureStorageReady();
    }

    if (req.method === "POST" && url.pathname === "/api/auth/request-access") {
      await handleAccessRequest(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/request-password-reset") {
      await handlePasswordResetRequest(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/reset-password") {
      await handlePasswordReset(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      await handleLogout(req, res);
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/auth/account") {
      await handleDeleteAccount(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/auth/session") {
      await handleSession(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cooperatives") {
      const profiles = await readRecords(COLLECTIONS.profiles);
      sendJson(
        res,
        200,
        profiles.filter((profile) => profile.published).map(publicProfile),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/profiles") {
      await handleProfileSubmission(req, res);
      return;
    }

    const approvalMatch = url.pathname.match(/^\/api\/listing-requests\/([^/]+)\/approve$/);
    if (req.method === "GET" && approvalMatch) {
      await handleApproveRequest(res, approvalMatch[1], url.searchParams.get("token"));
      return;
    }

    serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

if (require.main === module) {
  startServer();
}

async function startServer() {
  await ensureStorage();
  server.listen(PORT, () => {
    console.log(`Energy Agora server running at ${PUBLIC_BASE_URL}`);
    console.log(`Admin verification email: ${ADMIN_EMAIL}`);
    console.log(`Storage: ${USE_DATABASE ? "Postgres DATABASE_URL" : DATA_DIR}`);
    if (!RESEND_API_KEY) {
      console.log("RESEND_API_KEY is not set; notification emails will be saved to data/outbox.");
    }
  });
}

async function handler(req, res) {
  await handleRequest(req, res);
}

function ensureStorageReady() {
  if (!storageReadyPromise) storageReadyPromise = ensureStorage();
  return storageReadyPromise;
}

async function handleAccessRequest(req, res) {
  const body = await readBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const accountType = body.accountType === "formation" ? "formation" : "cooperative";
  const orgName = String(body.orgName || "").trim();
  const country = String(body.country || "").trim();

  if (!checkRateLimit(req, res, "access-ip", 30, 15 * 60 * 1000)) return;
  if (!checkRateLimit(req, res, `access:${email || "unknown"}`, 6, 15 * 60 * 1000)) return;

  if (!email || !password || !country || (accountType === "cooperative" && !orgName)) {
    sendJson(res, 400, {
      error:
        accountType === "formation"
          ? "Email, password, and country are required."
          : "Email, password, cooperative name, and country are required.",
    });
    return;
  }

  if (password.length < 8) {
    sendJson(res, 400, { error: "Password must be at least 8 characters." });
    return;
  }

  const accounts = await readRecords(COLLECTIONS.accounts);
  const existing = accounts.find((account) => account.email === email);

  if (existing) {
    const passwordResult = await verifyPassword(password, existing.passwordHash);
    if (!passwordResult.ok) {
      sendJson(res, 401, { error: "That email already has an account. Check the password and try again." });
      return;
    }

    if (passwordResult.needsUpgrade) {
      existing.passwordHash = await hashPassword(password);
      await writeRecords(COLLECTIONS.accounts, accounts);
    }

    await createSession(res, existing);
    sendJson(res, 200, {
      account: publicAccount(existing),
      isNewAccount: false,
    });
    return;
  }

  const account = {
    id: `acct_${crypto.randomUUID()}`,
    email,
    passwordHash: await hashPassword(password),
    orgName: orgName || "New energy co-op group",
    country,
    accountType,
    verificationStatus: "Pending manual review",
    createdAt: new Date().toISOString(),
  };

  accounts.push(account);
  await writeRecords(COLLECTIONS.accounts, accounts);

  const request = await createListingRequest(account);
  await notifyAdmin(request);

  await createSession(res, account);
  sendJson(res, 201, {
    account: publicAccount(account),
    isNewAccount: true,
    request: publicListingRequest(request),
  });
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!checkRateLimit(req, res, "login-ip", 30, 15 * 60 * 1000)) return;
  if (!checkRateLimit(req, res, `login:${email || "unknown"}`, 8, 15 * 60 * 1000)) return;

  if (!email || !password) {
    sendJson(res, 400, { error: "Email and password are required." });
    return;
  }

  const accounts = await readRecords(COLLECTIONS.accounts);
  const account = accounts.find((item) => item.email === email);
  if (!account) {
    sendJson(res, 401, { error: "Invalid email or password." });
    return;
  }

  const passwordResult = await verifyPassword(password, account.passwordHash);
  if (!passwordResult.ok) {
    sendJson(res, 401, { error: "Invalid email or password." });
    return;
  }

  if (passwordResult.needsUpgrade) {
    account.passwordHash = await hashPassword(password);
    await writeRecords(COLLECTIONS.accounts, accounts);
  }

  await createSession(res, account);
  sendJson(res, 200, { account: publicAccount(account) });
}

async function handleLogout(req, res) {
  await revokeSession(req);
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

async function handleDeleteAccount(req, res) {
  const auth = await getAuthenticatedSession(req);
  if (!auth) {
    sendJson(res, 401, { error: "Please log in before deleting your account." });
    return;
  }

  const accountId = auth.account.id;
  const [accounts, requests, profiles, sessions] = await Promise.all([
    readRecords(COLLECTIONS.accounts),
    readRecords(COLLECTIONS.requests),
    readRecords(COLLECTIONS.profiles),
    readRecords(COLLECTIONS.sessions),
  ]);

  await Promise.all([
    writeRecords(
      COLLECTIONS.accounts,
      accounts.filter((account) => account.id !== accountId),
    ),
    writeRecords(
      COLLECTIONS.requests,
      requests.filter((request) => request.accountId !== accountId),
    ),
    writeRecords(
      COLLECTIONS.profiles,
      profiles.filter((profile) => profile.accountId !== accountId),
    ),
    writeRecords(
      COLLECTIONS.sessions,
      sessions.filter((session) => session.accountId !== accountId),
    ),
  ]);

  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

async function handleSession(req, res) {
  const auth = await getAuthenticatedSession(req);
  const account = auth?.account || null;
  if (auth) {
    auth.session.expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
    await writeRecords(COLLECTIONS.sessions, pruneExpiredSessions(auth.sessions));
    setSessionCookie(res, auth.token);
  }
  sendJson(res, 200, { account: account ? publicAccount(account) : null });
}

async function handlePasswordResetRequest(req, res) {
  const body = await readBody(req);
  const email = String(body.email || "").trim().toLowerCase();

  if (!checkRateLimit(req, res, "reset-request-ip", 10, 60 * 60 * 1000)) return;
  if (!checkRateLimit(req, res, `reset-request:${email || "unknown"}`, 4, 60 * 60 * 1000)) return;

  if (!email) {
    sendJson(res, 400, { error: "Email is required." });
    return;
  }

  const accounts = await readRecords(COLLECTIONS.accounts);
  const account = accounts.find((item) => item.email === email);
  if (account) {
    await sendPasswordReset(account, accounts);
  }

  sendJson(res, 200, {
    ok: true,
    message: "If an account exists for that email, a password reset link has been sent.",
  });
}

async function handlePasswordReset(req, res) {
  const body = await readBody(req);
  const accountId = String(body.account || "").trim();
  const token = String(body.token || "");
  const password = String(body.password || "");

  if (!checkRateLimit(req, res, "reset-ip", 20, 60 * 60 * 1000)) return;
  if (!checkRateLimit(req, res, `reset:${accountId || getClientIp(req)}`, 6, 60 * 60 * 1000)) return;

  if (!accountId || !token || !password) {
    sendJson(res, 400, { error: "Reset token and new password are required." });
    return;
  }

  if (password.length < 8) {
    sendJson(res, 400, { error: "Password must be at least 8 characters." });
    return;
  }

  const accounts = await readRecords(COLLECTIONS.accounts);
  const account = accounts.find((item) => item.id === accountId);
  if (!account || !account.passwordResetTokenHash) {
    sendJson(res, 400, { error: "This password reset link is invalid or has already been used." });
    return;
  }

  if (Date.parse(account.passwordResetExpiresAt || "") < Date.now()) {
    sendJson(res, 400, { error: "This password reset link has expired." });
    return;
  }

  if (!timingSafeEqualText(hashToken(token), account.passwordResetTokenHash)) {
    sendJson(res, 400, { error: "This password reset link is invalid or has already been used." });
    return;
  }

  account.passwordHash = await hashPassword(password);
  delete account.passwordResetTokenHash;
  delete account.passwordResetExpiresAt;
  await writeRecords(COLLECTIONS.accounts, accounts);

  const sessions = await readRecords(COLLECTIONS.sessions);
  await writeRecords(
    COLLECTIONS.sessions,
    sessions.filter((session) => session.accountId !== account.id),
  );

  clearSessionCookie(res);
  sendJson(res, 200, { ok: true, message: "Password updated. Please log in with your new password." });
}

async function handleProfileSubmission(req, res) {
  const body = await readBody(req);
  const profile = body.profile || {};
  const account = await getAuthenticatedAccount(req);
  const listingGoals = normaliseListingGoals(profile.listingGoals);

  if (!account) {
    sendJson(res, 401, { error: "Please log in before submitting a profile." });
    return;
  }

  const name = cleanText(profile.name);
  const city = cleanText(profile.city);
  const country = cleanText(profile.country);
  const publicContact = cleanText(profile.publicContact);

  if (!name || !city || !country || !publicContact) {
    sendJson(res, 400, { error: "Cooperative name, city, country, and public contact email are required." });
    return;
  }

  if (!isValidEmail(publicContact)) {
    sendJson(res, 400, { error: "Enter a valid public contact email." });
    return;
  }

  const profiles = await readRecords(COLLECTIONS.profiles);
  const existing = profiles.find((item) => item.accountId === account.id);
  const savedProfile = {
    id: existing?.id || makeProfileId(name, profiles),
    accountId: account.id,
    ownerEmail: account.email,
    name,
    initials: cleanText(profile.initials) || getInitials(name),
    city,
    country,
    members: toNumber(profile.members),
    capacity: toNumber(profile.capacity),
    listingGoals,
    openMembers: listingGoals.includes("members") && Boolean(profile.openMembers),
    status: cleanText(profile.status) || "Open membership",
    publicContact,
    assets: normaliseAssets(profile.assets, profile.capacity),
    needs: ["Member onboarding"],
    memberCost: listingGoals.includes("members") ? cleanText(profile.memberCost) : "",
    electricityCost: listingGoals.includes("members") ? cleanText(profile.electricityCost) : "",
    formationStage: listingGoals.includes("formation") ? cleanText(profile.formationStage) : "",
    foundingMemberTarget: listingGoals.includes("formation") ? cleanText(profile.foundingMemberTarget) : "",
    formationShareCost: listingGoals.includes("formation") ? cleanText(profile.formationShareCost) : "",
    plannedAssets: listingGoals.includes("formation") ? cleanText(profile.plannedAssets) : "",
    utilityNeeds: listingGoals.includes("formation") ? cleanText(profile.utilityNeeds) : "",
    communityGoals: listingGoals.includes("formation") ? cleanText(profile.communityGoals) : "",
    liaisonSupport: listingGoals.includes("formation") ? cleanText(profile.liaisonSupport) : "",
    sellsSurplus: listingGoals.includes("surplus"),
    surplusVolume: listingGoals.includes("surplus") ? cleanText(profile.surplusVolume) : "",
    surplusRate: listingGoals.includes("surplus") ? cleanText(profile.surplusRate) : "",
    buyerMinimum: listingGoals.includes("surplus") ? cleanText(profile.buyerMinimum) : "",
    surplusAvailability: listingGoals.includes("surplus") ? cleanText(profile.surplusAvailability) : "",
    buyerContact: listingGoals.includes("surplus") ? cleanText(profile.buyerContact) : "",
    intro: cleanText(profile.intro),
    connections: [],
    color: cleanText(profile.color) || "#0e765d",
    photoUrl: cleanDataUrl(profile.photoUrl),
    verificationStatus: "Pending manual review",
    published: false,
    submittedAt: existing?.submittedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    publishedAt: null,
  };

  if (account.verificationStatus === "Verified") {
    savedProfile.verificationStatus = "Verified";
    savedProfile.published = true;
    savedProfile.publishedAt = existing?.publishedAt || new Date().toISOString();
  }

  if (existing) {
    Object.assign(existing, savedProfile);
  } else {
    profiles.unshift(savedProfile);
  }
  await writeRecords(COLLECTIONS.profiles, profiles);

  if (!savedProfile.published) {
    await notifyProfileSubmittedOnce(account, savedProfile);
  }

  sendJson(res, 201, {
    profile: publicProfile(savedProfile),
    verificationStatus: savedProfile.verificationStatus,
    published: savedProfile.published,
  });
}

async function createListingRequest(account) {
  const requests = await readRecords(COLLECTIONS.requests);
  const request = makeListingRequest(account);

  requests.unshift(request);
  await writeRecords(COLLECTIONS.requests, requests);
  return request;
}

function makeListingRequest(account) {
  return {
    id: `req_${crypto.randomUUID()}`,
    accountId: account.id,
    email: account.email,
    orgName: account.orgName,
    country: account.country,
    status: "Pending manual review",
    token: crypto.randomBytes(24).toString("hex"),
    requestedAt: new Date().toISOString(),
    approvedAt: null,
  };
}

async function notifyAdmin(request) {
  const approveUrl = `${PUBLIC_BASE_URL}/api/listing-requests/${encodeURIComponent(request.id)}/approve?token=${encodeURIComponent(request.token)}`;
  const subject = `New Energy Agora listing request: ${request.orgName}`;
  const text = [
    "A cooperative has requested listing access on Energy Agora.",
    "",
    `Cooperative: ${request.orgName}`,
    `Country: ${request.country}`,
    `Requester email: ${request.email}`,
    `Status: ${request.status}`,
    `Requested at: ${new Date(request.requestedAt).toLocaleString()}`,
    "",
    "Manual review checklist:",
    "- Check whether the requester email is associated with the cooperative.",
    "- Search public cooperative registry or official website.",
    "- Contact the cooperative through a public channel if needed.",
    "",
    "Approve after verification:",
    approveUrl,
  ].join("\n");

  await sendAdminEmail(subject, text, `${request.id}.eml`, getEmailMarkup(
    "New listing request",
    `A cooperative has requested listing access: ${escapeHtml(request.orgName)}.`,
    "Approve after verification",
    approveUrl,
    "Only use this link after you manually verify that the requester is associated with the cooperative.",
  ));
}

async function handleApproveRequest(res, requestId, token) {
  const requests = await readRecords(COLLECTIONS.requests);
  const request = requests.find((item) => item.id === requestId);

  if (!request || request.token !== token) {
    sendHtml(res, 404, "Approval link not found or expired.");
    return;
  }

  request.status = "Approved";
  request.approvedAt = new Date().toISOString();
  await writeRecords(COLLECTIONS.requests, requests);

  const accounts = await readRecords(COLLECTIONS.accounts);
  const account = accounts.find((item) => item.id === request.accountId);
  if (account) {
    account.verificationStatus = "Verified";
    account.verifiedAt = request.approvedAt;
    await writeRecords(COLLECTIONS.accounts, accounts);

    const profiles = await readRecords(COLLECTIONS.profiles);
    const profile = profiles.find((item) => item.accountId === account.id);
    if (profile) {
      profile.verificationStatus = "Verified";
      profile.published = true;
      profile.publishedAt = request.approvedAt;
      await writeRecords(COLLECTIONS.profiles, profiles);
    }
  }

  sendHtml(
    res,
    200,
    `<h1>Approved</h1><p>${escapeHtml(request.orgName)} has been marked as verified. If a profile draft exists, it is now public.</p><p>Requester: ${escapeHtml(request.email)}</p>`,
  );
}

async function getOpenListingRequest(account) {
  const requests = await readRecords(COLLECTIONS.requests);
  return requests.find(
    (request) => request.accountId === account.id && request.status !== "Approved",
  );
}

async function notifyProfileSubmittedOnce(account, profile) {
  const requests = await readRecords(COLLECTIONS.requests);
  let request = requests.find(
    (item) => item.accountId === account.id && item.status !== "Approved",
  );

  if (!request) {
    request = makeListingRequest(account);
    requests.unshift(request);
  }

  if (request.profileReviewEmailSentAt) return;

  await notifyProfileSubmitted(request, profile);
  request.profileReviewEmailSentAt = new Date().toISOString();
  await writeRecords(COLLECTIONS.requests, requests);
}

async function sendPasswordReset(account, accounts) {
  const token = crypto.randomBytes(32).toString("base64url");
  account.passwordResetTokenHash = hashToken(token);
  account.passwordResetExpiresAt = new Date(Date.now() + PASSWORD_RESET_MAX_AGE_MS).toISOString();
  await writeRecords(COLLECTIONS.accounts, accounts);

  const resetUrl = `${PUBLIC_BASE_URL}/reset.html?account=${encodeURIComponent(account.id)}&token=${encodeURIComponent(token)}`;
  const subject = "Reset your Energy Agora password";
  const text = [
    `Hi ${account.orgName || "there"},`,
    "",
    "Use this link to reset your Energy Agora password:",
    resetUrl,
    "",
    "This link expires in 30 minutes. If you did not request a reset, you can ignore this email.",
  ].join("\n");
  const html = getEmailMarkup(
    "Reset your password",
    "Use this private link to choose a new password for your Energy Agora account.",
    "Reset password",
    resetUrl,
    "This link expires in 30 minutes. If you did not request it, you can ignore this email.",
  );

  await sendEmail({
    to: account.email,
    subject,
    text,
    html,
    fallbackFileName: `password-reset-${account.id}.eml`,
  });
}

async function notifyProfileSubmitted(request, profile) {
  const approveUrl = `${PUBLIC_BASE_URL}/api/listing-requests/${encodeURIComponent(request.id)}/approve?token=${encodeURIComponent(request.token)}`;
  const subject = `Energy Agora profile ready for review: ${profile.name}`;
  const text = [
    "A cooperative profile draft has been submitted on Energy Agora.",
    "",
    `Cooperative: ${profile.name}`,
    `Country: ${profile.country}`,
    `City: ${profile.city}`,
    `Requester email: ${profile.ownerEmail}`,
    `Public contact: ${profile.publicContact || "Not listed"}`,
    `Members: ${profile.members || "Not listed"}`,
    `Joining cost: ${profile.memberCost || "Not listed"}`,
    `Electricity cost: ${profile.electricityCost || "Not listed"}`,
    `Listing purpose: ${formatListingGoals(profile.listingGoals)}`,
    `Starting point: ${profile.formationStage || "Not listed"}`,
    `People they hope to gather: ${profile.foundingMemberTarget || "Not listed"}`,
    `Early share cost: ${profile.formationShareCost || "Not listed"}`,
    `First project idea: ${profile.plannedAssets || "Not listed"}`,
    `Community goals: ${profile.communityGoals || "Not listed"}`,
    `Help wanted: ${profile.utilityNeeds || "Not listed"}`,
    `Why people should join early: ${profile.liaisonSupport || "Not listed"}`,
    `Surplus electricity: ${profile.sellsSurplus ? "Yes" : "No"}`,
    `Surplus volume: ${profile.surplusVolume || "Not listed"}`,
    `Business rate: ${profile.surplusRate || "Not listed"}`,
    `Minimum buyer: ${profile.buyerMinimum || "Not listed"}`,
    `Business contact: ${profile.buyerContact || "Not listed"}`,
    "",
    "Approve after verification:",
    approveUrl,
  ].join("\n");

  await sendAdminEmail(subject, text, `profile-${request.id}.eml`, getEmailMarkup(
    "Profile ready for review",
    `${escapeHtml(profile.name)} submitted a profile draft. Review the details in this email before approving.`,
    "Approve after verification",
    approveUrl,
    "Only use this link after you manually verify that the requester is associated with the cooperative.",
  ));
}

async function sendAdminEmail(subject, text, fallbackFileName, html = "") {
  await sendEmail({
    to: ADMIN_EMAIL,
    subject,
    text,
    html,
    fallbackFileName,
  });
}

async function sendEmail({ to, subject, text, html = "", fallbackFileName }) {
  if (RESEND_API_KEY) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to,
        subject,
        text,
        html: html || undefined,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend email failed: ${response.status} ${errorText}`);
    }
    return;
  }

  if (USE_DATABASE) {
    console.warn("RESEND_API_KEY is not set; email was not sent.");
    console.warn(`${subject}\nTo: ${to}\n${text}`);
    return;
  }

  const eml = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\n");
  fs.writeFileSync(path.join(OUTBOX_DIR, fallbackFileName), eml);
}

function checkRateLimit(req, res, scope, limit, windowMs) {
  const now = Date.now();
  const clientIp = getClientIp(req);
  const key = `${scope}:${clientIp}`;
  const bucket = rateLimitBuckets.get(key);

  for (const [bucketKey, value] of rateLimitBuckets) {
    if (value.resetAt <= now) rateLimitBuckets.delete(bucketKey);
  }

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    sendJson(res, 429, { error: "Too many attempts. Please wait a little and try again." });
    return false;
  }

  bucket.count += 1;
  return true;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function getEmailMarkup(title, intro, ctaLabel, ctaUrl, footer) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;color:#121614;line-height:1.5;max-width:560px">
      <h1 style="font-size:24px;margin:0 0 12px">${escapeHtml(title)}</h1>
      <p style="margin:0 0 20px;color:#4f5b56">${intro}</p>
      <p style="margin:26px 0">
        <a href="${escapeHtml(ctaUrl)}" style="background:#121614;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:700;display:inline-block">${escapeHtml(ctaLabel)}</a>
      </p>
      <p style="margin:0 0 18px;color:#68736f;font-size:14px">${escapeHtml(footer)}</p>
      <p style="margin:0;color:#68736f;font-size:12px">If the button does not open, copy this link: ${escapeHtml(ctaUrl)}</p>
    </div>
  `;
}

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(ROOT, requestedPath));

  if (!filePath.startsWith(ROOT)) {
    sendHtml(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendHtml(res, 404, "Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(content);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
}

function isStateChangingRequest(req) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
}

function requiresStorage(pathname) {
  return pathname.startsWith("/api/") && pathname !== "/api/health";
}

function isTrustedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    const publicOrigin = new URL(PUBLIC_BASE_URL).origin;
    const hostOrigin = `${PUBLIC_BASE_URL.startsWith("https://") ? "https" : "http"}://${req.headers.host}`;
    return origin === publicOrigin || origin === hostOrigin;
  } catch {
    return false;
  }
}

function isLocalRequest(req) {
  const host = req.headers.host || "";
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

async function ensureStorage() {
  if (!USE_DATABASE) {
    ensureDataFiles();
    return;
  }

  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS energy_agora_store (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (collection, id)
    )
  `);
}

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  if (!fs.existsSync(ACCOUNTS_FILE)) writeJson(ACCOUNTS_FILE, []);
  if (!fs.existsSync(REQUESTS_FILE)) writeJson(REQUESTS_FILE, []);
  if (!fs.existsSync(PROFILES_FILE)) writeJson(PROFILES_FILE, []);
  if (!fs.existsSync(SESSIONS_FILE)) writeJson(SESSIONS_FILE, []);
}

async function readRecords(collection) {
  if (!USE_DATABASE) return readJson(COLLECTION_FILES[collection]);

  const result = await getPool().query(
    "SELECT data FROM energy_agora_store WHERE collection = $1 ORDER BY updated_at DESC",
    [collection],
  );
  return result.rows.map((row) => row.data);
}

async function writeRecords(collection, values) {
  if (!USE_DATABASE) {
    writeJson(COLLECTION_FILES[collection], values);
    return;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM energy_agora_store WHERE collection = $1", [collection]);
    for (const value of values) {
      await client.query(
        "INSERT INTO energy_agora_store (collection, id, data, updated_at) VALUES ($1, $2, $3, NOW())",
        [collection, value.id, value],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function getPool() {
  if (dbPool) return dbPool;
  const { Pool } = require("pg");
  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });
  return dbPool;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  const value = JSON.parse(raw);
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Object.keys(value).length) return [value];
  return [];
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createSession(res, account) {
  const sessions = await readRecords(COLLECTIONS.sessions);
  const token = crypto.randomBytes(32).toString("base64url");
  const session = {
    id: `sess_${crypto.randomUUID()}`,
    accountId: account.id,
    tokenHash: hashSessionToken(token),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
  };

  sessions.push(session);
  await writeRecords(COLLECTIONS.sessions, pruneExpiredSessions(sessions));
  setSessionCookie(res, token);
}

async function getAuthenticatedAccount(req) {
  const auth = await getAuthenticatedSession(req);
  return auth?.account || null;
}

async function getAuthenticatedSession(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const sessions = await readRecords(COLLECTIONS.sessions);
  const now = Date.now();
  const session = sessions.find(
    (item) => item.tokenHash === tokenHash && Date.parse(item.expiresAt) > now,
  );
  if (!session) return null;

  const accounts = await readRecords(COLLECTIONS.accounts);
  const account = accounts.find((item) => item.id === session.accountId) || null;
  return account ? { account, session, sessions, token } : null;
}

async function revokeSession(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return;

  const tokenHash = hashSessionToken(token);
  const sessions = await readRecords(COLLECTIONS.sessions);
  await writeRecords(
    COLLECTIONS.sessions,
    sessions.filter((session) => session.tokenHash !== tokenHash),
  );
}

function pruneExpiredSessions(sessions) {
  const now = Date.now();
  return sessions.filter((session) => Date.parse(session.expiresAt) > now);
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (PUBLIC_BASE_URL.startsWith("https://")) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (PUBLIC_BASE_URL.startsWith("https://")) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map((item) => item.trim());
  const prefix = `${name}=`;
  const match = cookies.find((cookie) => cookie.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const key = await scrypt(password, salt);
  return `scrypt$${salt}$${key.toString("base64url")}`;
}

async function verifyPassword(password, storedHash) {
  if (String(storedHash || "").startsWith("scrypt$")) {
    const [, salt, expectedHash] = storedHash.split("$");
    if (!salt || !expectedHash) return { ok: false, needsUpgrade: true };
    const actual = (await scrypt(password, salt)).toString("base64url");
    return {
      ok: timingSafeEqualText(actual, expectedHash),
      needsUpgrade: false,
    };
  }

  const legacyHash = crypto.createHash("sha256").update(password).digest("hex");
  return {
    ok: timingSafeEqualText(legacyHash, String(storedHash || "")),
    needsUpgrade: true,
  };
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    orgName: account.orgName,
    country: account.country,
    accountType: account.accountType || "cooperative",
    verificationStatus: account.verificationStatus,
    createdAt: account.createdAt,
    verifiedAt: account.verifiedAt || null,
  };
}

function publicListingRequest(request) {
  return {
    id: request.id,
    accountId: request.accountId,
    email: request.email,
    orgName: request.orgName,
    country: request.country,
    status: request.status,
    requestedAt: request.requestedAt,
    approvedAt: request.approvedAt,
  };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    initials: profile.initials,
    city: profile.city,
    country: profile.country,
    members: profile.members,
    capacity: profile.capacity,
    listingGoals: normaliseListingGoals(profile.listingGoals),
    openMembers: profile.openMembers,
    status: profile.status,
    publicContact: profile.publicContact,
    assets: profile.assets,
    needs: profile.needs,
    memberCost: profile.memberCost,
    electricityCost: profile.electricityCost,
    formationStage: profile.formationStage,
    foundingMemberTarget: profile.foundingMemberTarget,
    formationShareCost: profile.formationShareCost,
    plannedAssets: profile.plannedAssets,
    utilityNeeds: profile.utilityNeeds,
    communityGoals: profile.communityGoals,
    liaisonSupport: profile.liaisonSupport,
    sellsSurplus: Boolean(profile.sellsSurplus || normaliseListingGoals(profile.listingGoals).includes("surplus")),
    surplusVolume: profile.surplusVolume,
    surplusRate: profile.surplusRate,
    buyerMinimum: profile.buyerMinimum,
    surplusAvailability: profile.surplusAvailability,
    buyerContact: profile.buyerContact,
    intro: profile.intro,
    connections: profile.connections,
    color: profile.color,
    photoUrl: profile.photoUrl,
    verificationStatus: profile.verificationStatus,
    publishedAt: profile.publishedAt,
  };
}

function normaliseAssets(assets, capacity) {
  if (Array.isArray(assets) && assets.length) {
    return assets.slice(0, 5).map((asset) => ({
      type: cleanText(asset.type) || "Member-owned energy",
      detail: cleanText(asset.detail) || "Cooperative portfolio",
      value: cleanText(asset.value) || `${toNumber(capacity).toFixed(1)} MW`,
    }));
  }

  const numericCapacity = toNumber(capacity);
  return [
    {
      type: "Member-owned energy",
      detail: "Cooperative portfolio",
      value: numericCapacity ? `${numericCapacity.toFixed(1)} MW` : "Not listed",
    },
  ];
}

function normaliseListingGoals(value) {
  if (!Array.isArray(value)) return ["members"];
  const goals = value;
  if (goals.includes("formation")) return ["formation"];
  const cleanGoals = goals.filter((goal) => ["members", "surplus", "formation"].includes(goal));
  return [...new Set(cleanGoals)];
}

function formatListingGoals(value) {
  const goals = normaliseListingGoals(value);
  if (!goals.length) return "profile only";
  return goals.join(", ");
}

function makeProfileId(value, profiles) {
  const base =
    cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "cooperative";
  let candidate = base;
  let count = 2;
  while (profiles.some((profile) => profile.id === candidate)) {
    candidate = `${base}-${count}`;
    count += 1;
  }
  return candidate;
}

function getInitials(value) {
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  return (words[0]?.[0] || "E").concat(words[1]?.[0] || "A").toUpperCase();
}

function toNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

function cleanText(value) {
  return String(value || "").trim().slice(0, 2000);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function cleanDataUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (!text.startsWith("data:image/")) return "";
  return text.slice(0, 2_000_000);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

module.exports = {
  handler,
  server,
};



