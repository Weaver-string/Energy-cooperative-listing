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
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;
let dbPool = null;
let storageReadyPromise = null;

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

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      await handleLogout(req, res);
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
  const orgName = String(body.orgName || "").trim();
  const country = String(body.country || "").trim();

  if (!email || !password || !orgName || !country) {
    sendJson(res, 400, { error: "Email, password, cooperative name, and country are required." });
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
    orgName,
    country,
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

async function handleSession(req, res) {
  const account = await getAuthenticatedAccount(req);
  sendJson(res, 200, { account: account ? publicAccount(account) : null });
}

async function handleProfileSubmission(req, res) {
  const body = await readBody(req);
  const profile = body.profile || {};
  const account = await getAuthenticatedAccount(req);

  if (!account) {
    sendJson(res, 401, { error: "Please log in before submitting a profile." });
    return;
  }

  const name = cleanText(profile.name);
  const city = cleanText(profile.city);
  const country = cleanText(profile.country);

  if (!name || !city || !country) {
    sendJson(res, 400, { error: "Cooperative name, city, and country are required." });
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
    listingGoals: normaliseListingGoals(profile.listingGoals),
    openMembers: Boolean(profile.openMembers),
    status: cleanText(profile.status) || "Open membership",
    assets: normaliseAssets(profile.assets, profile.capacity),
    needs: ["Member onboarding"],
    memberCost: cleanText(profile.memberCost),
    electricityCost: cleanText(profile.electricityCost),
    sellsSurplus: Boolean(profile.sellsSurplus || normaliseListingGoals(profile.listingGoals).includes("surplus")),
    surplusVolume: cleanText(profile.surplusVolume),
    surplusRate: cleanText(profile.surplusRate),
    buyerMinimum: cleanText(profile.buyerMinimum),
    surplusAvailability: cleanText(profile.surplusAvailability),
    buyerContact: cleanText(profile.buyerContact),
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
    const request = (await getOpenListingRequest(account)) || (await createListingRequest(account));
    await notifyProfileSubmitted(request, savedProfile);
  }

  sendJson(res, 201, {
    profile: publicProfile(savedProfile),
    verificationStatus: savedProfile.verificationStatus,
    published: savedProfile.published,
  });
}

async function createListingRequest(account) {
  const requests = await readRecords(COLLECTIONS.requests);
  const request = {
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

  requests.unshift(request);
  await writeRecords(COLLECTIONS.requests, requests);
  return request;
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

  await sendAdminEmail(subject, text, `${request.id}.eml`);
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
    `Members: ${profile.members || "Not listed"}`,
    `Joining cost: ${profile.memberCost || "Not listed"}`,
    `Electricity cost: ${profile.electricityCost || "Not listed"}`,
    `Listing purpose: ${normaliseListingGoals(profile.listingGoals).join(", ")}`,
    `Surplus electricity: ${profile.sellsSurplus ? "Yes" : "No"}`,
    `Surplus volume: ${profile.surplusVolume || "Not listed"}`,
    `Business rate: ${profile.surplusRate || "Not listed"}`,
    `Minimum buyer: ${profile.buyerMinimum || "Not listed"}`,
    `Business contact: ${profile.buyerContact || "Not listed"}`,
    "",
    "Approve after verification:",
    approveUrl,
  ].join("\n");

  await sendAdminEmail(subject, text, `profile-${request.id}.eml`);
}

async function sendAdminEmail(subject, text, fallbackFileName) {
  if (RESEND_API_KEY) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: ADMIN_EMAIL,
        subject,
        text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend email failed: ${response.status} ${errorText}`);
    }
    return;
  }

  if (USE_DATABASE) {
    console.warn("RESEND_API_KEY is not set; admin email was not sent.");
    console.warn(`${subject}\n${text}`);
    return;
  }

  const eml = [
    `To: ${ADMIN_EMAIL}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\n");
  fs.writeFileSync(path.join(OUTBOX_DIR, fallbackFileName), eml);
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
  return accounts.find((account) => account.id === session.accountId) || null;
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
    assets: profile.assets,
    needs: profile.needs,
    memberCost: profile.memberCost,
    electricityCost: profile.electricityCost,
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
  const goals = Array.isArray(value) ? value : [];
  const cleanGoals = goals.filter((goal) => ["members", "surplus"].includes(goal));
  return cleanGoals.length ? [...new Set(cleanGoals)] : ["members"];
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



