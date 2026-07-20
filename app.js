let cooperatives = [];

const state = {
  view: "browse",
  query: "",
  country: "All",
  audience: "all",
  asset: "all",
  selectedId: "",
  draftPhotoUrl: "",
  user: null,
  pendingProfile: null,
  profileSubmitted: false,
  authMode: "login",
  routeProfileId: "",
  routeApproved: false,
};

const EUROPEAN_COUNTRIES = [
  "Albania",
  "Andorra",
  "Austria",
  "Belgium",
  "Bosnia and Herzegovina",
  "Bulgaria",
  "Croatia",
  "Cyprus",
  "Czechia",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Iceland",
  "Ireland",
  "Italy",
  "Kosovo",
  "Latvia",
  "Liechtenstein",
  "Lithuania",
  "Luxembourg",
  "Malta",
  "Moldova",
  "Monaco",
  "Montenegro",
  "Netherlands",
  "North Macedonia",
  "Norway",
  "Poland",
  "Portugal",
  "Romania",
  "San Marino",
  "Serbia",
  "Slovakia",
  "Slovenia",
  "Spain",
  "Sweden",
  "Switzerland",
  "Ukraine",
  "United Kingdom",
];

const formatNumber = new Intl.NumberFormat("en-GB");
const BIO_HELPER_TEXT =
  "A short public bio will help potential members understand what this cooperative is building.";

async function safeJson(response, fallbackError = "An unexpected error occurred.") {
  let payload = {};
  try {
    payload = await response.json();
  } catch (err) {
    // If JSON parsing fails, we use an empty object
  }
  if (!response.ok) {
    throw new Error(payload.error || `${fallbackError} (Status ${response.status})`);
  }
  return payload;
}

const AuthProvider = {
  async getSession() {
    localStorage.removeItem("energy-agora.session.account");
    try {
      const response = await fetch("/api/auth/session");
      if (!response.ok) return null;
      const payload = await response.json();
      return payload.account || null;
    } catch (err) {
      return null;
    }
  },

  async requestAccess({ email, password, orgName, country, accountType }) {
    const response = await fetch("/api/auth/request-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, orgName, country, accountType }),
    });

    const payload = await safeJson(response, "Could not request listing access.");
    return {
      ...payload.account,
      isNewAccount: payload.isNewAccount,
    };
  },

  async login({ email, password }) {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const payload = await safeJson(response, "Could not log in.");
    return payload.account;
  },

  async requestPasswordReset(email) {
    const response = await fetch("/api/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    const payload = await safeJson(response, "Could not request a password reset.");
    return payload.message || "If an account exists for that email, a password reset link has been sent.";
  },

  async signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
  },

  async deleteAccount() {
    const response = await fetch("/api/auth/account", { method: "DELETE" });
    const payload = await safeJson(response, "Could not delete this account.");
    return payload;
  },

  async sendSupportMessage({ name, email, question }) {
    const response = await fetch("/api/support-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        email,
        question,
        page: window.location.href,
      }),
    });

    const payload = await safeJson(response, "Could not send your message.");
    return payload.message;
  },
};

const ProfileProvider = {
  async loadPublished() {
    try {
      const response = await fetch("/api/cooperatives");
      if (!response.ok) return [];
      return await response.json();
    } catch (err) {
      return [];
    }
  },

  async submit(profile) {
    if (!state.user) {
      throw new Error("Please request listing access before submitting a profile.");
    }

    const response = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    });

    const payload = await safeJson(response, "Could not submit this profile for review.");
    return payload;
  },
};

const browseView = document.querySelector("#browse-view");
const detailView = document.querySelector("#detail-view");
const authView = document.querySelector("#auth-view");
const profileList = document.querySelector("#profile-list");
const compactList = document.querySelector("#compact-list");
const profilePage = document.querySelector("#profile-page");
const createView = document.querySelector("#create-view");
const authForm = document.querySelector("#auth-form");
const profileForm = document.querySelector("#profile-form");
const submissionConfirmation = document.querySelector("#submission-confirmation");
const uploadAvatar = document.querySelector("#upload-avatar");
const resultCount = document.querySelector("#result-count");
const sideCount = document.querySelector("#side-count");
const searchInput = document.querySelector("#search");
const assetFilter = document.querySelector("#asset-filter");
const rowTemplate = document.querySelector("#profile-row-template");
const audienceButtons = document.querySelectorAll("[data-audience]");
const membershipSection = document.querySelector("#membership-section");
const surplusSection = document.querySelector("#surplus-section");
const formationSection = document.querySelector("#formation-section");
const listKicker = document.querySelector("#list-kicker");
const listTitle = document.querySelector("#list-title");
const listDescription = document.querySelector("#list-description");
const authModeButtons = document.querySelectorAll("[data-auth-mode]");
const requestOnlyFields = document.querySelectorAll("[data-request-only]");
const signupOnlyFields = document.querySelectorAll("[data-signup-only]");
const authTitle = document.querySelector("#auth-title");
const authCopy = document.querySelector("#auth-copy");
const authAccountHeading = document.querySelector("#auth-account-heading");
const authSubmitButton = document.querySelector("#auth-submit-button");
const authOrgName = document.querySelector("#auth-org-name");
const authCountry = document.querySelector("#auth-country");
const engineerDialog = document.querySelector("#engineer-dialog");
const engineerForm = document.querySelector("#engineer-form");
const engineerStatus = document.querySelector("#engineer-status");
const engineerSubmitButton = document.querySelector("#engineer-submit-button");

const LIST_COPY = {
  all: {
    kicker: "All co-ops",
    title: "All cooperative profiles",
    description:
      "Browse every verified cooperative on Energy Agora, including co-ops that are only publishing a profile for visibility.",
  },
  members: {
    kicker: "Looking to join",
    title: "Co-ops looking for members",
    description:
      "Find cooperatives that are actively open to people who want to join, compare membership costs, and understand member electricity pricing.",
  },
  surplus: {
    kicker: "Looking to buy electricity",
    title: "Co-ops open to electricity buyers",
    description:
      "Find cooperatives advertising surplus electricity, business rates, minimum buyer size, or potential PPA discussions.",
  },
  formation: {
    kicker: "New community groups",
    title: "Start or join a local energy co-op",
    description:
      "Find people in your country who are gathering neighbors, choosing a first project, and building a new energy community together.",
  },
};

async function init() {
  applyInitialRoute();
  state.user = await AuthProvider.getSession();
  renderCountryFilter();
  bindEvents();
  render();
  await loadOnlineProfiles();
}

function applyInitialRoute() {
  const params = new URLSearchParams(window.location.search);
  const query = clean(params.get("q"));
  const profileId = clean(params.get("profile"));
  state.routeApproved = params.get("approved") === "1";
  state.routeProfileId = profileId;

  if (query) {
    state.query = query.toLowerCase();
    if (searchInput) searchInput.value = query;
  }
}

async function loadOnlineProfiles() {
  try {
    const onlineProfiles = await ProfileProvider.loadPublished();
    cooperatives = onlineProfiles;
    renderCountryFilter();
    renderCountryOptions();
    applyApprovedProfileRoute();
    render();
  } catch (error) {
    console.warn("Could not load online cooperative profiles.", error);
  }
}

function applyApprovedProfileRoute() {
  if (!state.routeProfileId) return;
  const profile = cooperatives.find((coop) => coop.id === state.routeProfileId);
  if (!profile) return;

  state.view = "browse";
  state.selectedId = profile.id;
  state.query = "";
  state.country = "All";
  state.audience = "all";
  state.asset = "all";
  if (searchInput) searchInput.value = "";
  if (assetFilter) assetFilter.value = "all";
  state.routeProfileId = "";

  if (window.history?.replaceState) {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

function bindEvents() {
  document.querySelector("#home-button").addEventListener("click", showBrowse);
  document.querySelector("#back-button").addEventListener("click", showBrowse);
  document.querySelector("#login-button").addEventListener("click", handleLoginButton);
  document.querySelector("#auth-back-button").addEventListener("click", showBrowse);
  document.querySelector("#create-button").addEventListener("click", beginProfileSetup);
  document.querySelector("#create-back-button").addEventListener("click", showBrowse);
  document.querySelector("#confirmation-back-button").addEventListener("click", showBrowse);
  document.querySelector("#reset-profile-button").addEventListener("click", resetCreateForm);
  document.querySelector("#password-reset-button").addEventListener("click", handlePasswordResetRequest);
  document.querySelector("#delete-account-button").addEventListener("click", handleDeleteAccount);
  document.querySelector("#engineer-help-button").addEventListener("click", openEngineerHelp);
  document.querySelector("#engineer-close-button").addEventListener("click", closeEngineerHelp);
  document.querySelector("#engineer-cancel-button").addEventListener("click", closeEngineerHelp);

  authForm.addEventListener("submit", handleAuthSubmit);
  engineerForm.addEventListener("submit", handleEngineerMessageSubmit);
  profileForm.addEventListener("input", updateCreateFormState);
  profileForm.addEventListener("change", updateCreateFormState);
  profileForm.addEventListener("submit", publishProfile);
  document.querySelector("#new-photo").addEventListener("change", handlePhotoUpload);
  document.querySelector("#remove-photo-button").addEventListener("click", removeProfilePhoto);
  document.querySelector("#new-list-members").addEventListener("change", handleListingPurposeChange);
  document.querySelector("#new-list-surplus").addEventListener("change", handleListingPurposeChange);
  document.querySelector("#new-list-formation").addEventListener("change", handleListingPurposeChange);

  authModeButtons.forEach((button) => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  });

  audienceButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.audience = button.dataset.audience;
      audienceButtons.forEach((item) =>
        item.setAttribute("aria-pressed", String(item.dataset.audience === state.audience)),
      );
      showBrowse(false);
      render();
    });
  });

  searchInput.addEventListener("input", () => {
    state.query = searchInput.value.trim().toLowerCase();
    showBrowse(false);
    render();
  });

  assetFilter.addEventListener("change", () => {
    state.asset = assetFilter.value;
    render();
  });

}

function renderCountryFilter() {
  const container = document.querySelector("#country-filter");
  container.innerHTML = "";
  getListedCountries().forEach((country) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = country;
    button.setAttribute("aria-pressed", country === state.country);
    button.addEventListener("click", () => {
      state.country = country;
      [...container.children].forEach((child) =>
        child.setAttribute("aria-pressed", child.textContent === country),
      );
      render();
    });
    container.append(button);
  });
}

function getFilteredCoops() {
  const filtered = cooperatives.filter((coop) => {
    const searchable = [
      coop.name,
      coop.city,
      coop.country,
      coop.publicContact,
      coop.status,
      getPublicIntro(coop),
      coop.memberCost,
      coop.electricityCost,
      coop.surplusVolume,
      coop.surplusRate,
      coop.buyerMinimum,
      coop.surplusAvailability,
      coop.formationStage,
      coop.foundingMemberTarget,
      coop.formationShareCost,
      coop.plannedAssets,
      coop.utilityNeeds,
      coop.communityGoals,
      coop.liaisonSupport,
      ...(coop.assets || []).map((asset) => `${asset.type} ${asset.detail}`),
    ]
      .join(" ")
      .toLowerCase();

    const matchesQuery = !state.query || searchable.includes(state.query);
    const matchesCountry = state.country === "All" || coop.country === state.country;
    const matchesAsset =
      state.asset === "all" ||
      (coop.assets || []).some((asset) => asset.type.toLowerCase() === state.asset);
    const matchesAudience =
      state.audience === "all" ||
      (state.audience === "members" && listsForMembers(coop)) ||
      (state.audience === "surplus" && listsSurplus(coop)) ||
      (state.audience === "formation" && listsFormation(coop));

    return matchesQuery && matchesCountry && matchesAsset && matchesAudience;
  });

  return filtered.sort((a, b) => {
    return a.name.localeCompare(b.name);
  });
}

function render() {
  const filtered = getFilteredCoops();

  if (!filtered.some((coop) => coop.id === state.selectedId)) {
    state.selectedId = filtered[0]?.id || cooperatives[0]?.id || "";
  }

  renderShell();
  renderProfileList(filtered);
  renderProfilePage();
  renderCompactList(filtered);
}

function renderShell() {
  browseView.classList.toggle("is-hidden", state.view !== "browse");
  detailView.classList.toggle("is-hidden", state.view !== "detail");
  authView.classList.toggle("is-hidden", state.view !== "auth");
  createView.classList.toggle("is-hidden", state.view !== "create");
  profileForm.classList.toggle("is-hidden", state.view === "create" && state.profileSubmitted);
  submissionConfirmation.classList.toggle(
    "is-hidden",
    state.view !== "create" || !state.profileSubmitted,
  );
  document.body.classList.toggle("is-focused-flow", state.view === "create" || state.view === "auth");
  document.querySelector("#login-button").textContent = state.user ? "Log out" : "Log in";
  document.querySelector("#create-button").textContent = state.user ? "Edit listing" : "List a co-op";
  renderAuthMode();
  const copy = LIST_COPY[state.audience] || LIST_COPY.all;
  listKicker.textContent = copy.kicker;
  listTitle.textContent = copy.title;
  listDescription.textContent = copy.description;
}

function renderProfileList(coops) {
  resultCount.textContent = `${coops.length} ${coops.length === 1 ? "result" : "results"}`;
  profileList.innerHTML = "";

  if (!coops.length) {
    const copy = LIST_COPY[state.audience] || LIST_COPY.all;
    profileList.innerHTML = `<div class="empty-state">No cooperatives match ${escapeHtml(copy.title.toLowerCase())} yet.</div>`;
    return;
  }

  if (state.audience === "formation") {
    renderFormationCountryGroups(coops);
    return;
  }

  coops.forEach((coop) => profileList.append(createProfileRow(coop)));
}

function openEngineerHelp() {
  engineerStatus.textContent = "";
  if (state.user) {
    const emailInput = document.querySelector("#engineer-email");
    const nameInput = document.querySelector("#engineer-name");
    if (emailInput && !emailInput.value) emailInput.value = state.user.email || "";
    if (nameInput && !nameInput.value) nameInput.value = state.user.orgName || "";
  }

  if (engineerDialog.showModal) {
    engineerDialog.showModal();
  } else {
    engineerDialog.setAttribute("open", "");
  }
}

function closeEngineerHelp() {
  if (engineerDialog.open) engineerDialog.close();
}

async function handleEngineerMessageSubmit(event) {
  event.preventDefault();
  const form = new FormData(engineerForm);
  const name = clean(form.get("name"));
  const email = clean(form.get("email"));
  const question = clean(form.get("question"));

  engineerStatus.textContent = "Sending to a human engineer...";
  engineerSubmitButton.disabled = true;

  try {
    const message = await AuthProvider.sendSupportMessage({ name, email, question });
    engineerStatus.textContent = message;
    engineerForm.reset();
  } catch (error) {
    engineerStatus.textContent = error.message;
  } finally {
    engineerSubmitButton.disabled = false;
  }
}

function renderFormationCountryGroups(coops) {
  const groups = coops.reduce((acc, coop) => {
    const country = coop.country || "Country not listed";
    if (!acc.has(country)) acc.set(country, []);
    acc.get(country).push(coop);
    return acc;
  }, new Map());

  [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([country, countryCoops]) => {
      const section = document.createElement("section");
      section.className = "country-group";
      section.innerHTML = `
        <div class="country-group__header">
          <h3>${escapeHtml(country)}</h3>
          <span>${countryCoops.length} ${countryCoops.length === 1 ? "group" : "groups"}</span>
        </div>
      `;
      countryCoops.forEach((coop) => section.append(createProfileRow(coop)));
      profileList.append(section);
    });
}

function createProfileRow(coop) {
  const node = rowTemplate.content.cloneNode(true);
  const button = node.querySelector(".profile-row__button");
  const avatar = node.querySelector(".avatar");

  button.dataset.id = coop.id;
  button.classList.toggle("is-active", coop.id === state.selectedId);
  button.addEventListener("click", () => showDetail(coop.id));

  setAvatar(avatar, coop);
  node.querySelector(".profile-row__name").textContent = coop.name;
  node.querySelector(".profile-row__meta").textContent = getRowMeta(coop);
  const intro = getPublicIntro(coop);
  const introNode = node.querySelector(".profile-row__intro");
  introNode.textContent = intro;
  introNode.classList.toggle("is-hidden", !intro);

  return node;
}

function renderProfilePage() {
  const coop = getSelectedCoop();
  if (!coop) {
    profilePage.innerHTML = '<div class="empty-state">No approved cooperative profile is available yet.</div>';
    return;
  }

  profilePage.innerHTML = getProfileMarkup(coop, false);
}

function getProfileMarkup(coop, isPreview) {
  const memberCost = coop.memberCost || "Not listed";
  const electricityCost = coop.electricityCost || "Not listed";
  const verificationStatus = coop.verificationStatus || "Pending manual review";
  const capacity = Number(coop.capacity || 0);
  const assets = coop.assets || [];
  const purposeText = getPurposeText(coop);
  const intro = getPublicIntro(coop);
  const contactEmail = coop.publicContact || coop.buyerContact || "";
  const contactButton = contactEmail
    ? `<a class="button button--dark" href="mailto:${escapeHtml(contactEmail)}">${isPreview ? "Preview contact" : "Message"}</a>`
    : `<button class="button button--dark" type="button" disabled>${isPreview ? "Preview" : "Message"}</button>`;
  const formationSectionMarkup = listsFormation(coop)
    ? `
      <section class="detail-section">
        <h2>For people joining early</h2>
        <div class="profile-meta-grid profile-meta-grid--compact">
          <div class="detail-stat"><span>Right now</span><strong>${escapeHtml(coop.formationStage || "Gathering interested people")}</strong></div>
          <div class="detail-stat"><span>People needed</span><strong>${escapeHtml(coop.foundingMemberTarget || "Not listed")}</strong></div>
          <div class="detail-stat"><span>Early share</span><strong>${escapeHtml(coop.formationShareCost || coop.memberCost || "Not listed")}</strong></div>
          <div class="detail-stat"><span>First idea</span><strong>${escapeHtml(coop.plannedAssets || "Not listed")}</strong></div>
        </div>
        ${coop.communityGoals ? `<p><strong>Community goals:</strong> ${escapeHtml(coop.communityGoals)}</p>` : ""}
        ${coop.utilityNeeds ? `<p><strong>Help wanted:</strong> ${escapeHtml(coop.utilityNeeds)}</p>` : ""}
        ${coop.liaisonSupport ? `<p>${escapeHtml(coop.liaisonSupport)}</p>` : ""}
      </section>
    `
    : "";
  const memberSection = listsForMembers(coop)
    ? `
      <section class="detail-section">
        <h2>For people looking to join</h2>
        <div class="profile-meta-grid profile-meta-grid--compact">
          <div class="detail-stat"><span>Joining cost</span><strong>${escapeHtml(memberCost)}</strong></div>
          <div class="detail-stat"><span>Electricity cost</span><strong>${escapeHtml(electricityCost)}</strong></div>
          <div class="detail-stat"><span>Membership</span><strong>${coop.openMembers ? "Open" : "Waitlist"}</strong></div>
        </div>
      </section>
    `
    : "";
  const surplusSectionMarkup = listsSurplus(coop)
    ? `
      <section class="detail-section">
        <h2>For buyers looking for electricity</h2>
        <div class="profile-meta-grid profile-meta-grid--compact">
          <div class="detail-stat"><span>Available surplus</span><strong>${escapeHtml(coop.surplusVolume || "Not listed")}</strong></div>
          <div class="detail-stat"><span>Business rate</span><strong>${escapeHtml(coop.surplusRate || "Not listed")}</strong></div>
          <div class="detail-stat"><span>Minimum buyer</span><strong>${escapeHtml(coop.buyerMinimum || "Not listed")}</strong></div>
        </div>
        ${
          coop.surplusAvailability
            ? `<p>${escapeHtml(coop.surplusAvailability)}</p>`
            : ""
        }
      </section>
    `
    : "";
  return `
    <div class="profile-cover"></div>
    <div class="profile-page__body">
      <header class="profile-page__header">
        ${getAvatarMarkup(coop)}
        <p class="eyebrow">${escapeHtml(purposeText)} | ${escapeHtml(verificationStatus)}</p>
        <h1>${escapeHtml(coop.name)}</h1>
        <div class="profile-page__location">${escapeHtml(coop.city)}, ${escapeHtml(coop.country)}</div>
        ${intro ? `<p class="profile-page__intro">${escapeHtml(intro)}</p>` : ""}
      </header>

      <div class="profile-actions">
        ${contactButton}
        <button class="button button--light" type="button">Follow</button>
        <button class="button button--light" type="button">Share</button>
      </div>

      <section class="detail-section">
        <h2>Contact</h2>
        <p>${contactEmail ? `<a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a>` : "Contact email not listed."}</p>
      </section>

      <section class="profile-meta-grid" aria-label="Profile statistics">
        <div class="detail-stat"><span>Members</span><strong>${formatNumber.format(coop.members || 0)}</strong></div>
        <div class="detail-stat"><span>Owned capacity</span><strong>${capacity.toFixed(1)} MW</strong></div>
        <div class="detail-stat"><span>Verification</span><strong>${escapeHtml(verificationStatus)}</strong></div>
      </section>

      ${memberSection}
      ${formationSectionMarkup}
      ${surplusSectionMarkup}

      <section class="detail-section">
        <h2>Assets</h2>
        ${assets
          .map(
            (asset) =>
              `<div class="asset-line"><span>${escapeHtml(asset.type)} | ${escapeHtml(asset.detail)}</span><strong>${escapeHtml(asset.value)}</strong></div>`,
          )
          .join("")}
      </section>

    </div>
  `;
}

function renderCompactList(coops) {
  sideCount.textContent = coops.length;
  compactList.innerHTML = coops
    .map((coop) => {
      const activeClass = coop.id === state.selectedId ? " is-active" : "";
      return `
        <button class="compact-row${activeClass}" type="button" data-id="${escapeHtml(coop.id)}">
          ${getAvatarMarkup(coop)}
          <span class="compact-row__text">
            <strong>${escapeHtml(coop.name)}</strong>
            <span>${escapeHtml(coop.city)} | ${escapeHtml(Number(coop.capacity || 0).toFixed(1))} MW</span>
          </span>
        </button>
      `;
    })
    .join("");

  compactList.querySelectorAll("[data-id]").forEach((button) => {
    button.addEventListener("click", () => showDetail(button.dataset.id));
  });
}

function showBrowse(shouldRender = true) {
  state.view = "browse";
  if (shouldRender) render();
}

async function handleLoginButton() {
  if (!state.user) {
    showAuth("login");
    return;
  }

  await AuthProvider.signOut();
  state.user = null;
  state.profileSubmitted = false;
  profileForm.reset();
  state.draftPhotoUrl = "";
  showBrowse();
}

function showAuth(mode = "login") {
  state.view = "auth";
  setAuthMode(mode, false);
  renderCountryOptions();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function beginProfileSetup() {
  state.profileSubmitted = false;
  if (state.user) {
    showCreate();
    return;
  }
  showAuth(state.audience === "formation" ? "start" : "request");
}

function showCreate() {
  state.view = "create";
  state.profileSubmitted = false;
  renderCountryOptions();
  prefillProfileFromAccount();
  applyStarterDefaults();
  updateListingPurpose();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showDetail(id) {
  state.view = "detail";
  state.selectedId = id;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function getSelectedCoop() {
  return cooperatives.find((coop) => coop.id === state.selectedId) || cooperatives[0] || null;
}

function getCountries() {
  return ["All", ...new Set(cooperatives.map((coop) => coop.country).filter(Boolean))].sort((a, b) => {
    if (a === "All") return -1;
    if (b === "All") return 1;
    return a.localeCompare(b);
  });
}

function getListedCountries() {
  return getCountries();
}

function renderCountryOptions() {
  const listedCountries = cooperatives.map((coop) => coop.country).filter(Boolean);
  const countries = [...new Set([...EUROPEAN_COUNTRIES, ...listedCountries])].sort((a, b) =>
    a.localeCompare(b),
  );

  document.querySelector("#country-options").innerHTML = countries
    .map((country) => `<option value="${escapeHtml(country)}"></option>`)
    .join("");
}

function getDraftCoop() {
  const form = new FormData(profileForm);
  const name = clean(form.get("name")) || "Your cooperative";
  const city = clean(form.get("city")) || "City";
  const country = clean(form.get("country")) || "Country";
  const capacity = toNumber(form.get("capacity"));
  const assetValue = capacity ? `${capacity.toFixed(1)} MW` : "Not listed";
  const listingGoals = getListingGoals(form);
  const isListingMembers = listingGoals.includes("members");
  const isListingSurplus = listingGoals.includes("surplus");
  const isStartingCoop = listingGoals.includes("formation");

  return {
    id: "draft",
    name,
    initials: getInitials(name),
    city,
    country,
    members: Math.round(toNumber(form.get("members"))),
    capacity,
    listingGoals,
    openMembers: isListingMembers && form.get("openMembers") === "on",
    status: clean(form.get("status")) || "Open membership",
    publicContact: clean(form.get("publicContact")),
    assets: [{ type: "Member-owned energy", detail: "Cooperative portfolio", value: assetValue }],
    needs: ["Member onboarding"],
    memberCost: isListingMembers ? clean(form.get("memberCost")) : "",
    electricityCost: isListingMembers ? clean(form.get("electricityCost")) : "",
    formationStage: isStartingCoop ? clean(form.get("formationStage")) : "",
    foundingMemberTarget: isStartingCoop ? clean(form.get("foundingMemberTarget")) : "",
    formationShareCost: isStartingCoop ? clean(form.get("formationShareCost")) : "",
    plannedAssets: isStartingCoop ? clean(form.get("plannedAssets")) : "",
    utilityNeeds: isStartingCoop ? clean(form.get("utilityNeeds")) : "",
    communityGoals: isStartingCoop ? clean(form.get("communityGoals")) : "",
    liaisonSupport: isStartingCoop ? clean(form.get("liaisonSupport")) : "",
    sellsSurplus: isListingSurplus,
    surplusVolume: isListingSurplus ? clean(form.get("surplusVolume")) : "",
    surplusRate: isListingSurplus ? clean(form.get("surplusRate")) : "",
    buyerMinimum: isListingSurplus ? clean(form.get("buyerMinimum")) : "",
    surplusAvailability: isListingSurplus ? clean(form.get("surplusAvailability")) : "",
    buyerContact: isListingSurplus ? clean(form.get("buyerContact")) : "",
    intro: clean(form.get("intro")),
    connections: [],
    color: clean(form.get("color")) || "#0e765d",
    photoUrl: state.draftPhotoUrl,
    verificationStatus: state.user ? state.user.verificationStatus : "Unverified",
    ownerEmail: state.user?.email || "",
  };
}

async function publishProfile(event) {
  event.preventDefault();
  const draft = getDraftCoop();

  const profile = {
    ...draft,
    id: makeId(draft.name),
    verificationStatus: "Pending manual review",
  };

  try {
    const saved = await ProfileProvider.submit(profile);
    state.pendingProfile = saved.profile;
  } catch (error) {
    window.alert(error.message);
    return;
  }

  state.profileSubmitted = true;
  render();
  submissionConfirmation.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
  profileForm.reset();
  state.draftPhotoUrl = "";
}

function resetCreateForm() {
  profileForm.reset();
  state.draftPhotoUrl = "";
  updateListingPurpose();
  updateCreateFormState();
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = new FormData(authForm);
  const email = clean(form.get("email"));
  const password = clean(form.get("password"));
  const isLoginMode = state.authMode === "login";
  const isStartMode = state.authMode === "start";

  try {
    state.user = isLoginMode
      ? await AuthProvider.login({ email, password })
      : await AuthProvider.requestAccess({
          email,
          password,
          orgName: isStartMode ? clean(form.get("orgName")) || "New energy co-op group" : clean(form.get("orgName")),
          country: clean(form.get("country")),
          accountType: isStartMode ? "formation" : "cooperative",
        });
  } catch (error) {
    window.alert(error.message);
    return;
  }

  showCreate();
}

function setAuthMode(mode, shouldRender = true) {
  state.authMode = ["request", "start"].includes(mode) ? mode : "login";
  authOrgName.required = state.authMode === "request";
  authCountry.required = state.authMode !== "login";
  if (shouldRender) renderAuthMode();
}

function renderAuthMode() {
  const isRequestMode = state.authMode === "request";
  const isStartMode = state.authMode === "start";
  const isSignupMode = isRequestMode || isStartMode;
  authModeButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.authMode === state.authMode));
  });
  requestOnlyFields.forEach((element) => {
    element.classList.toggle("is-hidden", !isRequestMode);
  });
  signupOnlyFields.forEach((element) => {
    element.classList.toggle("is-hidden", !isSignupMode);
  });

  if (isStartMode) {
    authTitle.textContent = "Start a local energy co-op.";
    authCopy.textContent =
      "Create a simple account, then make a recruiting page for people who might join your new community.";
    authAccountHeading.textContent = "Create account";
    authSubmitButton.textContent = "Start drafting";
    return;
  }

  authTitle.textContent = isRequestMode ? "Request listing access." : "Log in to your co-op account.";
  authCopy.textContent = isRequestMode
    ? "Create a secure account to draft your profile. New requests are reviewed manually before the cooperative is marked verified or appears publicly."
    : "Returning co-ops can log in with just an email and password, then continue editing their profile.";
  authAccountHeading.textContent = isRequestMode ? "Account details" : "Log in";
  authSubmitButton.textContent = isRequestMode ? "Request access" : "Log in";
}

async function handlePasswordResetRequest() {
  const email = clean(document.querySelector("#auth-email").value);
  if (!email) {
    window.alert("Enter the account email first, then request a reset link.");
    return;
  }

  try {
    const message = await AuthProvider.requestPasswordReset(email);
    window.alert(message);
  } catch (error) {
    window.alert(error.message);
  }
}

function prefillProfileFromAccount() {
  if (!state.user) return;

  const nameInput = document.querySelector("#new-name");
  const countryInput = document.querySelector("#new-country");
  const publicContactInput = document.querySelector("#new-public-contact");
  if (!nameInput.value) nameInput.value = state.user.orgName;
  if (!countryInput.value) countryInput.value = state.user.country;
  if (!publicContactInput.value) publicContactInput.value = state.user.email;
}

function applyStarterDefaults() {
  if (state.authMode !== "start" && state.user?.accountType !== "formation") return;

  const formationToggle = document.querySelector("#new-list-formation");
  const memberToggle = document.querySelector("#new-list-members");
  const surplusToggle = document.querySelector("#new-list-surplus");
  const statusInput = document.querySelector("#new-status");
  if (formationToggle && !formationToggle.checked) formationToggle.checked = true;
  if (memberToggle) memberToggle.checked = false;
  if (surplusToggle) surplusToggle.checked = false;
  if (statusInput && statusInput.value === "Open membership") statusInput.value = "New community group";
}

async function handleDeleteAccount() {
  if (!state.user) return;

  const confirmed = window.confirm(
    "Delete this Energy Agora account and remove its profile from the site? This cannot be undone.",
  );
  if (!confirmed) return;

  try {
    await AuthProvider.deleteAccount();
  } catch (error) {
    window.alert(error.message);
    return;
  }

  state.user = null;
  state.profileSubmitted = false;
  state.draftPhotoUrl = "";
  profileForm.reset();
  await loadOnlineProfiles();
  showBrowse();
}

function handleListingPurposeChange(event) {
  const memberToggle = document.querySelector("#new-list-members");
  const surplusToggle = document.querySelector("#new-list-surplus");
  const formationToggle = document.querySelector("#new-list-formation");

  if (event?.target === formationToggle && formationToggle.checked) {
    memberToggle.checked = false;
    surplusToggle.checked = false;
  }

  if ((event?.target === memberToggle || event?.target === surplusToggle) && event.target.checked) {
    formationToggle.checked = false;
  }

  updateListingPurpose();
}

function updateListingPurpose() {
  const memberToggle = document.querySelector("#new-list-members");
  const surplusToggle = document.querySelector("#new-list-surplus");
  const formationToggle = document.querySelector("#new-list-formation");

  membershipSection.classList.toggle("field-hidden", !memberToggle.checked);
  surplusSection.classList.toggle("field-hidden", !surplusToggle.checked);
  formationSection.classList.toggle("field-hidden", !formationToggle.checked);
  updateCreateFormState();
}

function updateCreateFormState() {
  const draft = getDraftCoop();
  uploadAvatar.innerHTML = draft.photoUrl
    ? `<img src="${draft.photoUrl}" alt="" />`
    : escapeHtml(draft.initials);
  uploadAvatar.style.background = draft.color;
}

function getListingGoals(form) {
  const goals = [];
  if (form.get("listingFormation") === "on") return ["formation"];
  if (form.get("listingMembers") === "on") goals.push("members");
  if (form.get("listingSurplus") === "on") goals.push("surplus");
  return goals;
}

function listsForMembers(coop) {
  return !Array.isArray(coop.listingGoals) ? true : coop.listingGoals.includes("members");
}

function listsSurplus(coop) {
  return Boolean(coop.sellsSurplus || coop.listingGoals?.includes("surplus"));
}

function listsFormation(coop) {
  return Boolean(coop.listingGoals?.includes("formation"));
}

function getPurposeText(coop) {
  const purposes = [];
  if (listsForMembers(coop)) purposes.push("Members");
  if (listsFormation(coop)) purposes.push("New community");
  if (listsSurplus(coop)) purposes.push("Surplus power");
  return purposes.join(" + ") || "Profile only";
}

function getRowMeta(coop) {
  const location = `${coop.city}, ${coop.country}`;
  if (state.audience === "surplus" && listsSurplus(coop)) {
    return `${location} / ${coop.surplusVolume || "Surplus available"} / ${coop.surplusRate || "Rate not listed"} / ${coop.buyerMinimum || "Buyer size flexible"}`;
  }

  if (state.audience === "formation" && listsFormation(coop)) {
    return `${location} / ${coop.formationStage || "Gathering interested people"} / ${coop.formationShareCost || coop.memberCost || "Share cost not listed"} / ${coop.foundingMemberTarget || "People needed not listed"}`;
  }

  if (state.audience === "all" && listsFormation(coop) && !listsForMembers(coop)) {
    return `${location} / New energy community / ${coop.plannedAssets || "First project idea not listed"}`;
  }

  if (state.audience === "all" && listsSurplus(coop) && !listsForMembers(coop)) {
    return `${location} / Electricity buyers / ${coop.surplusRate || "Rate not listed"}`;
  }

  if (!listsForMembers(coop)) {
    return `${location} / Profile only / ${Number(coop.capacity || 0).toFixed(1)} MW owned capacity`;
  }

  return `${location} / ${formatNumber.format(coop.members || 0)} members / ${coop.memberCost || "Joining cost not listed"} / ${coop.electricityCost || "Power price not listed"}`;
}

function handlePhotoUpload(event) {
  const file = event.target.files?.[0];
  if (!file) {
    state.draftPhotoUrl = "";
    updateCreateFormState();
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    state.draftPhotoUrl = String(reader.result || "");
    updateCreateFormState();
  });
  reader.readAsDataURL(file);
}

function removeProfilePhoto() {
  const photoInput = document.querySelector("#new-photo");
  photoInput.value = "";
  state.draftPhotoUrl = "";
  updateCreateFormState();
}

function setAvatar(element, coop) {
  element.style.background = coop.color;
  element.innerHTML = coop.photoUrl
    ? `<img src="${escapeHtml(coop.photoUrl)}" alt="" />`
    : escapeHtml(coop.initials);
}

function getAvatarMarkup(coop) {
  const content = coop.photoUrl
    ? `<img src="${escapeHtml(coop.photoUrl)}" alt="" />`
    : escapeHtml(coop.initials);
  return `<div class="avatar" style="background:${escapeHtml(coop.color)}">${content}</div>`;
}

function makeId(value) {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  let candidate = base || "cooperative";
  let count = 2;
  while (cooperatives.some((coop) => coop.id === candidate)) {
    candidate = `${base}-${count}`;
    count += 1;
  }
  return candidate;
}

function getInitials(value) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return (words[0]?.[0] || "E").concat(words[1]?.[0] || "A").toUpperCase();
}

function toNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

function clean(value) {
  return String(value || "").trim();
}

function getPublicIntro(coop) {
  const intro = clean(coop?.intro);
  return intro === BIO_HELPER_TEXT ? "" : intro;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

init();



