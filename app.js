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
const AuthProvider = {
  async getSession() {
    localStorage.removeItem("energy-agora.session.account");
    const response = await fetch("/api/auth/session");
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.account || null;
  },

  async requestAccess({ email, password, orgName, country }) {
    const response = await fetch("/api/auth/request-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, orgName, country }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not request listing access.");
    }

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

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not log in.");
    }

    return payload.account;
  },

  async requestPasswordReset(email) {
    const response = await fetch("/api/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not request a password reset.");
    }
    return payload.message || "If an account exists for that email, a password reset link has been sent.";
  },

  async signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
  },
};

const ProfileProvider = {
  async loadPublished() {
    const response = await fetch("/api/cooperatives");
    if (!response.ok) return [];
    return response.json();
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

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not submit this profile for review.");
    }
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
const listKicker = document.querySelector("#list-kicker");
const listTitle = document.querySelector("#list-title");
const listDescription = document.querySelector("#list-description");
const authModeButtons = document.querySelectorAll("[data-auth-mode]");
const requestOnlyFields = document.querySelectorAll("[data-request-only]");
const authTitle = document.querySelector("#auth-title");
const authCopy = document.querySelector("#auth-copy");
const authAccountHeading = document.querySelector("#auth-account-heading");
const authSubmitButton = document.querySelector("#auth-submit-button");
const authOrgName = document.querySelector("#auth-org-name");
const authCountry = document.querySelector("#auth-country");

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
};

async function init() {
  state.user = await AuthProvider.getSession();
  renderCountryFilter();
  bindEvents();
  render();
  await loadOnlineProfiles();
}

async function loadOnlineProfiles() {
  try {
    const onlineProfiles = await ProfileProvider.loadPublished();
    if (!onlineProfiles.length) return;

    const onlineIds = new Set(onlineProfiles.map((profile) => profile.id));
    cooperatives = [
      ...onlineProfiles,
      ...cooperatives.filter((profile) => !onlineIds.has(profile.id)),
    ];
    renderCountryFilter();
    renderCountryOptions();
    render();
  } catch (error) {
    console.warn("Could not load online cooperative profiles.", error);
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

  authForm.addEventListener("submit", handleAuthSubmit);
  profileForm.addEventListener("input", updateCreateFormState);
  profileForm.addEventListener("change", updateCreateFormState);
  profileForm.addEventListener("submit", publishProfile);
  document.querySelector("#new-photo").addEventListener("change", handlePhotoUpload);
  document.querySelector("#new-list-members").addEventListener("change", updateListingPurpose);
  document.querySelector("#new-list-surplus").addEventListener("change", updateListingPurpose);

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
      coop.status,
      coop.intro,
      coop.memberCost,
      coop.electricityCost,
      coop.surplusVolume,
      coop.surplusRate,
      coop.buyerMinimum,
      coop.surplusAvailability,
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
      (state.audience === "surplus" && listsSurplus(coop));

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

  coops.forEach((coop) => profileList.append(createProfileRow(coop)));
}

function createProfileRow(coop) {
  const node = rowTemplate.content.cloneNode(true);
  const button = node.querySelector(".profile-row__button");
  const avatar = node.querySelector(".avatar");

  button.classList.toggle("is-active", coop.id === state.selectedId);
  button.addEventListener("click", () => showDetail(coop.id));

  setAvatar(avatar, coop);
  node.querySelector(".profile-row__name").textContent = coop.name;
  node.querySelector(".profile-row__meta").textContent = getRowMeta(coop);
  node.querySelector(".profile-row__intro").textContent = coop.intro;

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
        <p class="profile-page__intro">${escapeHtml(coop.intro)}</p>
      </header>

      <div class="profile-actions">
        <button class="button button--dark" type="button">${isPreview ? "Preview" : "Message"}</button>
        <button class="button button--light" type="button">Follow</button>
        <button class="button button--light" type="button">Share</button>
      </div>

      <section class="profile-meta-grid" aria-label="Profile statistics">
        <div class="detail-stat"><span>Members</span><strong>${formatNumber.format(coop.members || 0)}</strong></div>
        <div class="detail-stat"><span>Owned capacity</span><strong>${capacity.toFixed(1)} MW</strong></div>
        <div class="detail-stat"><span>Verification</span><strong>${escapeHtml(verificationStatus)}</strong></div>
      </section>

      ${memberSection}
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
  showAuth("request");
}

function showCreate() {
  state.view = "create";
  state.profileSubmitted = false;
  renderCountryOptions();
  prefillProfileFromAccount();
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
    assets: [{ type: "Member-owned energy", detail: "Cooperative portfolio", value: assetValue }],
    needs: ["Member onboarding"],
    memberCost: isListingMembers ? clean(form.get("memberCost")) : "",
    electricityCost: isListingMembers ? clean(form.get("electricityCost")) : "",
    sellsSurplus: isListingSurplus,
    surplusVolume: isListingSurplus ? clean(form.get("surplusVolume")) : "",
    surplusRate: isListingSurplus ? clean(form.get("surplusRate")) : "",
    buyerMinimum: isListingSurplus ? clean(form.get("buyerMinimum")) : "",
    surplusAvailability: isListingSurplus ? clean(form.get("surplusAvailability")) : "",
    buyerContact: isListingSurplus ? clean(form.get("buyerContact")) : "",
    intro:
      clean(form.get("intro")) ||
      "A short public bio will help potential members understand what this cooperative is building.",
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

  if (draft.name === "Your cooperative" || draft.city === "City" || draft.country === "Country") {
    profileForm.reportValidity();
    return;
  }

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

  try {
    state.user =
      state.authMode === "login"
        ? await AuthProvider.login({ email, password })
        : await AuthProvider.requestAccess({
            email,
            password,
            orgName: clean(form.get("orgName")),
            country: clean(form.get("country")),
          });
  } catch (error) {
    window.alert(error.message);
    return;
  }

  showCreate();
}

function setAuthMode(mode, shouldRender = true) {
  state.authMode = mode === "request" ? "request" : "login";
  authOrgName.required = state.authMode === "request";
  authCountry.required = state.authMode === "request";
  if (shouldRender) renderAuthMode();
}

function renderAuthMode() {
  const isRequestMode = state.authMode === "request";
  authModeButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.authMode === state.authMode));
  });
  requestOnlyFields.forEach((element) => {
    element.classList.toggle("is-hidden", !isRequestMode);
  });
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
  if (!nameInput.value) nameInput.value = state.user.orgName;
  if (!countryInput.value) countryInput.value = state.user.country;
}

function updateListingPurpose() {
  const memberToggle = document.querySelector("#new-list-members");
  const surplusToggle = document.querySelector("#new-list-surplus");

  membershipSection.classList.toggle("field-hidden", !memberToggle.checked);
  surplusSection.classList.toggle("field-hidden", !surplusToggle.checked);
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

function getPurposeText(coop) {
  const purposes = [];
  if (listsForMembers(coop)) purposes.push("Members");
  if (listsSurplus(coop)) purposes.push("Surplus power");
  return purposes.join(" + ") || "Profile only";
}

function getRowMeta(coop) {
  const location = `${coop.city}, ${coop.country}`;
  if (state.audience === "surplus" && listsSurplus(coop)) {
    return `${location} / ${coop.surplusVolume || "Surplus available"} / ${coop.surplusRate || "Rate not listed"} / ${coop.buyerMinimum || "Buyer size flexible"}`;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

init();



