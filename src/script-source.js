import * as AutomergeModule from "@automerge/automerge/slim";
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";

await AutomergeModule.initializeBase64Wasm(automergeWasmBase64);

const Automerge = AutomergeModule;

const panels = Array.from(document.querySelectorAll(".slide-panel"));
const slideNames = panels.map((panel) => panel.getAttribute("aria-label") || "");
const track = document.querySelector(".slide-track");
const tabs = Array.from(document.querySelectorAll("[data-slide]"));
const versionSwitcher = document.querySelector("[data-version-switcher]");
const versionHandle = document.querySelector("[data-version-handle]");
const versionDial = document.querySelector("[data-version-dial]");
const versionList = document.querySelector("#version-list");
const signalLog = document.querySelector("#signal-log");
const generationConsole = document.querySelector("#generation-console");
const feedbackForm = document.querySelector("#feedback-form");
const feedbackHandle = document.querySelector("#feedback-handle");
const feedbackSection = document.querySelector("#feedback-section");
const feedbackText = document.querySelector("#feedback-text");
const automergeStatus = document.querySelector("[data-automerge-status]");

const PRODUCTION_SIGNAL_ORIGIN = "https://mysimplewebsite-two.vercel.app";
const SIGNAL_ENDPOINT =
    window.location.hostname === "perrinmyerson.github.io" &&
    PRODUCTION_SIGNAL_ORIGIN
        ? `${PRODUCTION_SIGNAL_ORIGIN}/api/site-signal`
        : "/api/site-signal";
const PUBLISHED_LINEAGE_URL = "data/site-lineage.json";
const AUTOMERGE_KEY = "perrin-site-automerge-v1";
const JSON_KEY = "perrin-site-lineage-v1";
const VISITOR_COOKIE = "perrin_site_visitor";
const BASE_VERSION_ID = "v1";
const POLL_INTERVAL_MS = 5000;
const POLL_ATTEMPTS = 18;
const STATUS_ORDER = ["queued", "generating", "merged"];
const STATUS_LABELS = {
    queued: "sent",
    generating: "generating",
    merged: "merged/live",
    failed: "failed",
};
const LEGACY_VERSION_IDS = new Set([
    "base",
    "rami-scroll",
    "bosch-weird",
    "benji-basic-final",
    "benji-feedback-final",
    "benji-signal-loop-final",
]);
const REMOVED_VERSION_FALLBACKS = new Map([
    ["custom-eileen", "custom-codex-live-test"],
]);
const REMOVED_CONTRIBUTOR_KEYS = new Set(["@eileen"]);

let baseVariantSnapshot = null;
let activePollTimer = null;

const seedLineage = {
    currentVersion: BASE_VERSION_ID,
    versions: [
        {
            id: BASE_VERSION_ID,
            label: "Version 1",
            contributor: "@perrinmyerson + Codex",
            createdAt: "2026-05-28",
            summary:
                "Preserved baseline: plain white article pages with hover notes, Bosch image studies, feedback, and version lineage.",
            source: "",
            locked: true,
            treatment: { tone: "plain", imageDensity: "normal" },
        },
    ],
    signals: [],
};

let activeIndex = 0;
let wheelTotal = 0;
let lastWheelAt = 0;
let dialFocusIndex = 0;
let dialWheelTotal = 0;
let lastDialWheelAt = 0;
let dialScrollTimer = null;
let slideLocked = false;
let touchStartY = 0;
let touchStartScroll = 0;
let lineageDoc = Automerge.from(clone(seedLineage));
let automergeReady = false;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
        return {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
        }[character];
    });
}

function readCookie(name) {
    return document.cookie
        .split("; ")
        .find((cookie) => cookie.startsWith(`${name}=`))
        ?.split("=")[1];
}

function ensureVisitorId() {
    const existing = readCookie(VISITOR_COOKIE);

    if (existing) return decodeURIComponent(existing);

    const id =
        window.crypto?.randomUUID?.() ||
        `visitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    document.cookie = `${VISITOR_COOKIE}=${encodeURIComponent(
        id,
    )}; Max-Age=31536000; Path=/; SameSite=Lax`;

    return id;
}

function bytesToBase64(bytes) {
    let binary = "";
    bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
    });
    return window.btoa(binary);
}

function base64ToBytes(value) {
    return Uint8Array.from(window.atob(value), (character) =>
        character.charCodeAt(0),
    );
}

function contributorKey(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function versionSlug(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/^@/, "")
        .replace(/\s*\+\s*/g, "-")
        .replace(/[^a-z0-9_.-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48);
}

function versionIdForHandle(handle) {
    return `custom-${versionSlug(handle) || "visitor"}`;
}

function normalizeVersionId(id, contributor) {
    if (!id) return versionIdForHandle(contributor);
    if (id === BASE_VERSION_ID || LEGACY_VERSION_IDS.has(id)) return BASE_VERSION_ID;
    if (contributorKey(contributor)) return versionIdForHandle(contributor);
    return id;
}

function removedVersionFallback(id) {
    const key = String(id || "").trim().toLowerCase();
    return REMOVED_VERSION_FALLBACKS.get(key) || BASE_VERSION_ID;
}

function isRemovedVersionId(id) {
    return REMOVED_VERSION_FALLBACKS.has(String(id || "").trim().toLowerCase());
}

function isRemovedContributor(value) {
    return REMOVED_CONTRIBUTOR_KEYS.has(contributorKey(value));
}

function mergeLineages(...lineages) {
    const merged = {
        currentVersion: seedLineage.currentVersion,
        versions: [],
        signals: [],
    };
    const originalToStable = new Map(
        [...LEGACY_VERSION_IDS].map((id) => [id, BASE_VERSION_ID]),
    );
    const signalIds = new Set();
    let currentCandidate = BASE_VERSION_ID;

    function addBaseVersion(version) {
        const next = {
            ...clone(seedLineage.versions[0]),
            ...(version ? clone(version) : {}),
            id: BASE_VERSION_ID,
            label: "Version 1",
            source: "",
            locked: true,
        };
        const index = merged.versions.findIndex(
            (item) => item.id === BASE_VERSION_ID,
        );

        if (index === -1) {
            merged.versions.unshift(next);
        } else {
            merged.versions[index] = next;
        }
    }

    function addVersion(rawVersion) {
        if (!rawVersion?.id) return;

        const stableId = normalizeVersionId(rawVersion.id, rawVersion.contributor);
        const removed =
            isRemovedVersionId(rawVersion.id) ||
            isRemovedVersionId(stableId) ||
            isRemovedContributor(rawVersion.contributor);
        originalToStable.set(
            rawVersion.id,
            removed ? removedVersionFallback(stableId) : stableId,
        );

        if (removed) return;

        if (stableId === BASE_VERSION_ID) {
            if (rawVersion.id === BASE_VERSION_ID) addBaseVersion(rawVersion);
            return;
        }

        const version = { ...clone(rawVersion), id: stableId };
        const key = contributorKey(version.contributor);
        let existingIndex = merged.versions.findIndex(
            (item) => item.id === stableId,
        );

        if (key) {
            const contributorIndex = merged.versions.findIndex(
                (item) =>
                    item.id !== BASE_VERSION_ID &&
                    contributorKey(item.contributor) === key,
            );
            if (contributorIndex !== -1) existingIndex = contributorIndex;
        }

        if (existingIndex === -1) {
            merged.versions.push(version);
            existingIndex = merged.versions.length - 1;
        } else {
            merged.versions[existingIndex] = {
                ...merged.versions[existingIndex],
                ...version,
                id: stableId,
            };
        }

        if (!key) return;

        for (let index = merged.versions.length - 1; index >= 0; index -= 1) {
            if (
                index !== existingIndex &&
                merged.versions[index].id !== BASE_VERSION_ID &&
                contributorKey(merged.versions[index].contributor) === key
            ) {
                merged.versions.splice(index, 1);
            }
        }
    }

    function normalizeVersionRef(id) {
        if (!id) return BASE_VERSION_ID;
        if (id === BASE_VERSION_ID || LEGACY_VERSION_IDS.has(id)) {
            return BASE_VERSION_ID;
        }
        if (isRemovedVersionId(id)) return removedVersionFallback(id);

        const stableId = originalToStable.get(id) || id;
        return isRemovedVersionId(stableId)
            ? removedVersionFallback(stableId)
            : stableId;
    }

    lineages.filter(Boolean).forEach((lineage) => {
        if (lineage.currentVersion) currentCandidate = lineage.currentVersion;

        (lineage.versions || []).forEach(addVersion);

        (lineage.signals || []).forEach((rawSignal) => {
            if (!rawSignal?.id || signalIds.has(rawSignal.id)) return;
            const signal = clone(rawSignal);
            const stableVersionId = normalizeVersionId(
                signal.versionId,
                signal.handle,
            );
            if (
                isRemovedVersionId(signal.versionId) ||
                isRemovedVersionId(stableVersionId) ||
                isRemovedContributor(signal.handle)
            ) {
                return;
            }

            signal.versionId = stableVersionId;
            signal.sourceVersion = normalizeVersionRef(signal.sourceVersion);
            signalIds.add(signal.id);
            merged.signals.push(signal);
        });
    });

    if (!merged.versions.some((version) => version.id === BASE_VERSION_ID)) {
        addBaseVersion();
    }

    const stableCurrent = normalizeVersionRef(currentCandidate);
    merged.currentVersion = merged.versions.some(
        (version) => version.id === stableCurrent,
    )
        ? stableCurrent
        : BASE_VERSION_ID;

    return merged;
}

function getPlainLineage() {
    if (automergeReady && Automerge?.toJS) {
        return mergeLineages(seedLineage, Automerge.toJS(lineageDoc));
    }

    return mergeLineages(seedLineage, clone(Automerge.toJS(lineageDoc)));
}

function persistLineage() {
    const plain = getPlainLineage();
    localStorage.setItem(JSON_KEY, JSON.stringify(plain));
    localStorage.setItem(AUTOMERGE_KEY, bytesToBase64(Automerge.save(lineageDoc)));
}

function mutateLineage(mutator) {
    lineageDoc = Automerge.change(lineageDoc, mutator);
    automergeReady = true;
    persistLineage();
    renderLineage();
}

function currentVersionId() {
    const urlVersion = new URLSearchParams(window.location.search).get("v");
    const requested =
        urlVersion || document.body.dataset.currentVersion || seedLineage.currentVersion;
    if (isRemovedVersionId(requested)) {
        const fallback = removedVersionFallback(requested);
        const url = new URL(window.location.href);
        url.searchParams.set("v", fallback);
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        return fallback;
    }
    return LEGACY_VERSION_IDS.has(requested) ? BASE_VERSION_ID : requested;
}

function currentVersion(lineage = getPlainLineage()) {
    return (
        lineage.versions.find((version) => version.id === currentVersionId()) ||
        lineage.versions.find((version) => version.id === lineage.currentVersion) ||
        lineage.versions[lineage.versions.length - 1]
    );
}

function currentVersionIndex(lineage = getPlainLineage()) {
    const version = currentVersion(lineage);
    const index = lineage.versions.findIndex((item) => item.id === version?.id);
    return Math.max(index, 0);
}

function versionUrl(id) {
    const url = new URL(window.location.href);
    url.searchParams.set("v", id);
    return `${url.pathname}${url.search}`;
}

function selectVersion(id) {
    const nextId = LEGACY_VERSION_IDS.has(id) ? BASE_VERSION_ID : id;
    const url = new URL(window.location.href);
    url.searchParams.set("v", nextId);
    document.body.dataset.currentVersion = nextId;
    window.history.replaceState({}, "", url);
    renderLineage();
}

function syncDisplayedVersionUrl(version, lineage) {
    const requested = new URLSearchParams(window.location.search).get("v");

    if (!requested || requested === version?.id) return;

    if (LEGACY_VERSION_IDS.has(requested) || isRemovedVersionId(requested)) {
        const url = new URL(window.location.href);
        url.searchParams.set("v", version.id);
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
}

function setDialOpen(isOpen) {
    if (!versionSwitcher) return;
    const lineage = getPlainLineage();

    if (isOpen) {
        dialFocusIndex = currentVersionIndex(lineage);
        dialWheelTotal = 0;
        renderVersionDial(lineage, currentVersion(lineage));
    } else {
        versionSwitcher.classList.remove("is-scrolling");
    }

    versionSwitcher.classList.toggle("is-open", isOpen);
    versionHandle?.setAttribute("aria-expanded", String(isOpen));
}

function versionNumber(index) {
    return index + 1;
}

function formatDate(value) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new Date(
              ...value
                  .split("-")
                  .map((part, index) => Number(part) - (index === 1 ? 1 : 0)),
          )
        : new Date(value);

    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function summarize(text) {
    const clean = text.trim().replace(/\s+/g, " ");
    return clean.length > 96 ? `${clean.slice(0, 93)}...` : clean;
}

function normalizeHandle(value) {
    const cleaned = value.trim().replace(/\s+/g, "-").replace(/[^\w@.-]/g, "");

    if (!cleaned) {
        return `@visitor-${ensureVisitorId().slice(-4)}`;
    }

    return cleaned.startsWith("@") ? cleaned.slice(0, 32) : `@${cleaned.slice(0, 31)}`;
}

function signalToVersion(signal, status = "queued") {
    return {
        id: signal.versionId,
        label: `${signal.section} variation`,
        contributor: signal.handle,
        createdAt: signal.createdAt,
        summary: summarize(signal.text),
        source: signal.sourceVersion,
        status,
        treatment: { tone: "generated", imageDensity: "normal" },
    };
}

function setThemeProperty(name, value) {
    const property = `--version-${name}`;

    if (value) {
        document.documentElement.style.setProperty(property, value);
    } else {
        document.documentElement.style.removeProperty(property);
    }
}

function applyVersionTreatment(version) {
    const treatment = version?.treatment || {};
    const theme = version?.theme || {};

    document.documentElement.dataset.versionTone =
        theme.tone || treatment.tone || "plain";
    document.documentElement.dataset.imageDensity =
        theme.imageDensity || treatment.imageDensity || "normal";
    document.documentElement.dataset.versionFlavor =
        version?.id === BASE_VERSION_ID
            ? "base"
            : theme.flavor || (version?.content ? "generated" : "pending");

    ["accent", "background", "text", "muted", "rule", "link", "image-filter"].forEach(
        (name) => setThemeProperty(name, ""),
    );

    setThemeProperty("accent", theme.accent);
    setThemeProperty("background", theme.background);
    setThemeProperty("text", theme.text);
    setThemeProperty("muted", theme.muted);
    setThemeProperty("rule", theme.rule);
    setThemeProperty("link", theme.link);
    setThemeProperty("image-filter", theme.imageFilter);

    if (theme.fontFamily) {
        document.documentElement.style.setProperty(
            "--version-font-family",
            theme.fontFamily,
        );
    } else {
        document.documentElement.style.removeProperty("--version-font-family");
    }
}

function variantTargets() {
    return {
        homeName: document.querySelector("#header h1"),
        homeLinks: document.querySelector("#header ul"),
        homeMain: document.querySelector("#main .top"),
        quote: document.querySelector(".quote i"),
        aboutTitle: document.querySelector("#about .article-header h1"),
        aboutTime: document.querySelector("#about .article-header time"),
        timelineTitle: document.querySelector("#timeline .article-header h1"),
        timelineTime: document.querySelector("#timeline .article-header time"),
        timelineList: document.querySelector("#timeline .writing-list"),
        notesTitle: document.querySelector("#notes .article-header h1"),
        notesTime: document.querySelector("#notes .article-header time"),
        articleLinks: document.querySelector("#notes .article-links"),
    };
}

function captureBaseVariant() {
    if (baseVariantSnapshot) return;

    const targets = variantTargets();
    baseVariantSnapshot = {
        html: Object.fromEntries(
            Object.entries(targets).map(([key, element]) => [
                key,
                element?.innerHTML || "",
            ]),
        ),
        articles: {
            about: document.querySelector("#about .benji-article")?.innerHTML || "",
            timeline:
                document.querySelector("#timeline .benji-article")?.innerHTML || "",
            notes: document.querySelector("#notes .benji-article")?.innerHTML || "",
        },
    };
}

function restoreBaseVariant() {
    captureBaseVariant();

    const targets = variantTargets();
    Object.entries(targets).forEach(([key, element]) => {
        if (element) element.innerHTML = baseVariantSnapshot.html[key];
    });

    document.querySelectorAll(".version-note").forEach((note) => note.remove());
    document.documentElement.removeAttribute("data-active-version-id");
    document.body.classList.remove("version-swap");

    Object.entries(baseVariantSnapshot.articles).forEach(([id, html]) => {
        const article = document.querySelector(`#${id} .benji-article`);
        if (article) article.innerHTML = html;
    });
}

function signalForVersion(version, lineage) {
    if (!version) return null;

    const key = contributorKey(version.contributor);
    return [...(lineage.signals || [])].reverse().find((signal) => {
        return (
            signal.versionId === version.id ||
            (key && contributorKey(signal.handle) === key)
        );
    });
}

function requestForVersion(version, lineage) {
    return signalForVersion(version, lineage)?.text || version?.summary || "";
}

function versionIndex(version, lineage) {
    return Math.max(
        0,
        (lineage.versions || []).findIndex((item) => item.id === version?.id),
    );
}

function insertVersionNote(article, version, lineage, request) {
    const header = article?.querySelector(".article-header");
    if (!header || !version) return;

    const note = document.createElement("p");
    note.className = "version-note";
    note.innerHTML = `
        <span>Version ${versionNumber(versionIndex(version, lineage))}</span>
        ${escapeHtml(version.contributor)} requested: ${escapeHtml(summarize(request))}
    `;
    header.after(note);
}

function insertAllVersionNotes(version, lineage, request) {
    document.querySelectorAll(".article-page .benji-article").forEach((article) => {
        insertVersionNote(article, version, lineage, request);
    });
}

function renderLinks(links = []) {
    return links
        .filter((link) => link?.label && link?.href)
        .map(
            (link) =>
                `<a class="basic-link" href="${escapeHtml(link.href)}">${escapeHtml(
                    link.label,
                )}</a>`,
        )
        .join("");
}

function renderParagraphs(paragraphs = []) {
    return paragraphs
        .filter(Boolean)
        .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
        .join("");
}

function renderImages(images = []) {
    const cleanImages = images.filter((image) => image?.src);
    if (!cleanImages.length) return "";

    const rowClass = cleanImages.length === 2 ? "image-row two-up" : "image-row";
    return `
        <div class="${rowClass}" aria-label="Generated image studies">
            ${cleanImages
                .slice(0, 6)
                .map(
                    (image) => `
                        <figure class="image-tile">
                            <img
                                src="${escapeHtml(image.src)}"
                                alt="${escapeHtml(image.alt || image.caption || "")}"
                            />
                            <figcaption>${escapeHtml(image.caption || "")}</figcaption>
                        </figure>
                    `,
                )
                .join("")}
        </div>
    `;
}

function renderTimelineItems(items = []) {
    if (!items.length) return "";

    return `
        <ul class="writing-list">
            ${items
                .map(
                    (item) => `
                        <li>
                            <span>${escapeHtml(item.label || item.text || "")}</span>
                            <span>${escapeHtml(item.meta || item.time || "")}</span>
                        </li>
                    `,
                )
                .join("")}
        </ul>
    `;
}

function articleHtml(page = {}, fallbackTitle = "Generated") {
    return `
        <header class="article-header">
            <h1>${escapeHtml(page.title || fallbackTitle)}</h1>
            <time>${escapeHtml(page.time || "Generated version")}</time>
        </header>
        ${renderTimelineItems(page.items || [])}
        ${renderParagraphs(page.paragraphs || [])}
        ${renderImages(page.images || [])}
        ${
            page.links?.length
                ? `<nav class="article-links" aria-label="Links">${renderLinks(
                      page.links,
                  )}</nav>`
                : ""
        }
    `;
}

function applyGeneratedContent(version, lineage, request) {
    const content = version.content || {};
    const targets = variantTargets();

    if (targets.homeName && content.home?.name) {
        targets.homeName.textContent = content.home.name;
    }

    if (targets.homeLinks && content.home?.links?.length) {
        targets.homeLinks.innerHTML = content.home.links
            .filter((link) => link?.label && link?.href)
            .map(
                (link) =>
                    `<li><a href="${escapeHtml(link.href)}">${escapeHtml(
                        link.label,
                    )}</a></li>`,
            )
            .join("");
    }

    if (targets.homeMain && content.home?.main?.length) {
        targets.homeMain.innerHTML = content.home.main
            .map((paragraph) => escapeHtml(paragraph))
            .join("<br /><br />");
    }

    if (targets.quote && content.home?.quote) {
        targets.quote.textContent = content.home.quote;
    }

    [
        ["about", content.about, "About"],
        ["timeline", content.timeline, "Timeline"],
        ["notes", content.notes, "Notes"],
    ].forEach(([id, page, fallbackTitle]) => {
        if (!page) return;
        const article = document.querySelector(`#${id} .benji-article`);
        if (article) article.innerHTML = articleHtml(page, fallbackTitle);
    });

    insertAllVersionNotes(version, lineage, request);
}

function applyVersionProjection(version, lineage) {
    restoreBaseVariant();

    if (!version || version.id === BASE_VERSION_ID) return;

    const request = requestForVersion(version, lineage);
    document.documentElement.dataset.activeVersionId = version.id;

    if (version.content) {
        applyGeneratedContent(version, lineage, request);
    } else {
        insertAllVersionNotes(version, lineage, request);
    }

    window.requestAnimationFrame(() => {
        document.body.classList.add("version-swap");
    });
}

function renderContributorHandle(lineage = getPlainLineage()) {
    const version = currentVersion(lineage);

    if (!versionHandle || !version) return;

    document.body.dataset.currentVersion = version.id;
    syncDisplayedVersionUrl(version, lineage);
    versionHandle.textContent = version.contributor;
    versionHandle.title = `Customized by ${version.contributor}`;
    applyVersionTreatment(version);
    applyVersionProjection(version, lineage);
}

function renderVersionDial(lineage, activeVersion) {
    if (!versionDial) return;

    const versions = lineage.versions || [];
    const count = versions.length;
    const activeIndex = Math.max(
        versions.findIndex((version) => version.id === activeVersion?.id),
        0,
    );
    const isOpen = Boolean(versionSwitcher?.classList.contains("is-open"));
    const visibleRadius = 2;
    const progress =
        count > 1 ? `${Math.round((activeIndex / (count - 1)) * 100)}%` : "0%";

    if (!isOpen) dialFocusIndex = activeIndex;

    dialFocusIndex = clamp(dialFocusIndex, 0, Math.max(count - 1, 0));
    versionSwitcher?.classList.toggle("has-scrollable-dial", count > visibleRadius * 2 + 1);
    versionSwitcher?.style.setProperty("--dial-progress", progress);
    versionDial.dataset.versionCount = String(count);

    versionDial.innerHTML = versions
        .map((version, index) => {
            const relative = index - activeIndex;
            const hidden = Math.abs(relative) > visibleRadius;
            const arcSlot = clamp(relative, -visibleRadius, visibleRadius);
            const orbitAngle = -arcSlot * 20;
            const radius = 196;
            const radians = (orbitAngle * Math.PI) / 180;
            const x = Math.round(Math.cos(radians) * -radius - 24);
            const y = Math.round(Math.sin(radians) * radius + 172);
            const rotation = Math.round(orbitAngle * -0.72);
            const distance = Math.abs(relative);
            const scale = Math.max(0.86, 1 - Math.min(distance, 6) * 0.025);
            const opacity = hidden ? 0 : Math.max(0.62, 1 - distance * 0.06);
            const zIndex = 40 - distance;
            const active = version.id === activeVersion?.id;

            return `
                <button
                    class="version-dial-item"
                    type="button"
                    data-version-link="${escapeHtml(version.id)}"
                    data-dial-hidden="${hidden ? "true" : "false"}"
                    aria-current="${active ? "true" : "false"}"
                    aria-hidden="${hidden ? "true" : "false"}"
                    tabindex="${hidden ? "-1" : "0"}"
                    title="${escapeHtml(version.label)} by ${escapeHtml(version.contributor)}"
                    style="--dial-x: ${x}px; --dial-y: ${y}px; --dial-rotation: ${rotation}deg; --dial-scale: ${scale.toFixed(
                      2,
                  )}; --dial-opacity: ${opacity.toFixed(
                      2,
                  )}; --dial-z: ${zIndex}; --dial-angle: ${orbitAngle}deg; --dial-closed-rotation: ${Math.round(
                      rotation * 0.55,
                  )}deg; --dial-delay: ${Math.min(
                      distance,
                      visibleRadius,
                  ) * 26}ms"
                >
                    <span class="version-dial-index">${versionNumber(index)}</span>
                    <span class="version-dial-handle">${escapeHtml(
                        version.contributor,
                    )}</span>
                </button>
            `;
        })
        .join("");
}

function signalStatus(signal, lineage) {
    if (signal.status === "failed") return "failed";

    const version = (lineage.versions || []).find(
        (item) => item.id === signal.versionId,
    );
    if (version?.status === "merged" || signal.status === "merged") return "merged";
    if (signal.status === "generating" || signal.status === "queued") {
        return signal.status;
    }
    return "queued";
}

function stackVersions(lineage, activeVersion) {
    const versions = lineage.versions || [];
    const activeIndex = Math.max(
        versions.findIndex((version) => version.id === activeVersion?.id),
        0,
    );
    const indexes = [
        activeIndex,
        activeIndex + 1,
        activeIndex - 1,
        activeIndex + 2,
        activeIndex - 2,
        versions.length - 1,
        0,
    ];
    const seen = new Set();
    const selected = [];

    indexes.forEach((index) => {
        if (index < 0 || index >= versions.length || seen.has(index)) return;
        seen.add(index);
        selected.push({ version: versions[index], index });
    });

    return selected.slice(0, 4);
}

function renderStatusSteps(status) {
    if (status === "failed") {
        return `<div class="status-steps is-failed"><span>failed</span></div>`;
    }

    const activeIndex = Math.max(0, STATUS_ORDER.indexOf(status));
    return `
        <div class="status-steps">
            ${STATUS_ORDER.map((step, index) => {
                const isDone = index < activeIndex;
                const isActive = index === activeIndex;
                return `<span class="${isDone ? "is-done" : ""} ${
                    isActive ? "is-active" : ""
                }">${STATUS_LABELS[step]}</span>`;
            }).join("")}
        </div>
    `;
}

function externalLink(url, label) {
    return url
        ? `<a class="basic-link" href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
        : "";
}

function renderGenerationConsole(lineage) {
    if (!generationConsole) return;

    const latest = [...(lineage.signals || [])].reverse()[0];
    if (!latest) {
        generationConsole.innerHTML = `
            <div class="generation-heading">Automatic chaos</div>
            <p>No live generation signals yet.</p>
        `;
        return;
    }

    const status = signalStatus(latest, lineage);
    const links = [
        externalLink(latest.runUrl, "workflow"),
        externalLink(latest.prUrl, "pull request"),
        externalLink(latest.statusUrl, "runs"),
    ].filter(Boolean);

    generationConsole.innerHTML = `
        <div class="generation-heading">Automatic chaos</div>
        ${renderStatusSteps(status)}
        <p>
            ${escapeHtml(latest.handle)} -> ${escapeHtml(latest.section)}:
            ${escapeHtml(summarize(latest.text))}
        </p>
        ${links.length ? `<div class="generation-links">${links.join("")}</div>` : ""}
    `;
}

function renderLineage() {
    const lineage = getPlainLineage();
    const activeVersion = currentVersion(lineage);

    renderContributorHandle(lineage);
    renderVersionDial(lineage, activeVersion);
    renderGenerationConsole(lineage);

    if (automergeStatus) {
        automergeStatus.textContent = automergeReady
            ? "Automerge local merge"
            : "Automerge initializing";
    }

    if (versionList) {
        versionList.innerHTML = stackVersions(lineage, activeVersion)
            .map(({ version, index }, stackIndex) => {
                const active = version.id === activeVersion?.id ? " aria-current=\"page\"" : "";
                const status = version.status
                    ? ` · ${STATUS_LABELS[version.status] || version.status}`
                    : "";
                const links = [
                    externalLink(version.prUrl, "PR"),
                    externalLink(version.runUrl, "run"),
                ].filter(Boolean);
                const x = stackIndex * 0.78;
                const y = stackIndex * 0.92;
                const rotation = stackIndex === 0 ? 0 : -2.2 + stackIndex * 1.35;
                return `
                    <li
                        class="version-stack-card"
                        style="--stack-x: ${x.toFixed(2)}rem; --stack-y: ${y.toFixed(
                          2,
                      )}rem; --stack-rotation: ${rotation.toFixed(
                          2,
                      )}deg; --stack-z: ${10 - stackIndex};"
                    >
                        <div class="version-row">
                            <a class="basic-link" href="${escapeHtml(
                                versionUrl(version.id),
                            )}" data-version-link="${escapeHtml(version.id)}"${active}>
                                Version ${versionNumber(index)} · ${escapeHtml(version.label)}
                            </a>
                            <span>${escapeHtml(version.contributor)}</span>
                        </div>
                        <p>${escapeHtml(version.summary)} · ${escapeHtml(
                            formatDate(version.createdAt),
                        )}${escapeHtml(status)}${
                            links.length
                                ? ` <span class="version-links">${links.join(" ")}</span>`
                                : ""
                        }</p>
                    </li>
                `;
            })
            .join("");
    }

    if (signalLog) {
        const signals = lineage.signals.slice(-5).reverse();
        signalLog.innerHTML = signals.length
            ? `<span>Signals</span><ol>${signals
                  .map(
                      (signal) => `
                        <li>${escapeHtml(signal.handle)} -> ${escapeHtml(
                          signal.section,
                      )}: ${escapeHtml(summarize(signal.text))}
                        <span>${escapeHtml(
                            STATUS_LABELS[signalStatus(signal, lineage)] ||
                                signalStatus(signal, lineage),
                        )}</span></li>
                    `,
                  )
                  .join("")}</ol>`
            : "<span>No signals yet.</span>";
    }
}

async function fetchPublishedLineage() {
    try {
        const response = await fetch(PUBLISHED_LINEAGE_URL, { cache: "no-store" });
        if (!response.ok) return null;
        return response.json();
    } catch {
        return null;
    }
}

async function initLineage() {
    const published = await fetchPublishedLineage();
    const savedJson = localStorage.getItem(JSON_KEY);
    const savedPlain = savedJson ? JSON.parse(savedJson) : null;
    const savedAutomerge = localStorage.getItem(AUTOMERGE_KEY);
    const savedAutoPlain = savedAutomerge
        ? Automerge.toJS(Automerge.load(base64ToBytes(savedAutomerge)))
        : null;

    lineageDoc = Automerge.from(
        mergeLineages(seedLineage, savedPlain, savedAutoPlain, published),
    );
    automergeReady = true;
    persistLineage();
    renderLineage();
}

function setActiveTab(index) {
    activeIndex = Math.max(0, Math.min(index, panels.length - 1));
    track.style.transform = `translateY(-${100 * activeIndex}vh)`;

    panels.forEach((panel, panelIndex) => {
        panel.setAttribute("aria-hidden", panelIndex !== activeIndex);
    });

    tabs.forEach((tab) => {
        const isActive = Number(tab.dataset.slide) === activeIndex;
        tab.className = isActive ? "tab-active" : "tab-inactive";
        tab.setAttribute("aria-current", isActive ? "page" : "false");
    });

    document.title =
        activeIndex === 0 ? "perrin" : `perrin | ${slideNames[activeIndex]}`;
}

function nextSlide() {
    if (activeIndex < panels.length - 1) setActiveTab(activeIndex + 1);
}

function previousSlide() {
    if (activeIndex > 0) setActiveTab(activeIndex - 1);
}

function lockSlides() {
    slideLocked = true;
    window.setTimeout(() => {
        slideLocked = false;
    }, 900);
}

function onWheel(event) {
    if (slideLocked) return;

    const panel = panels[activeIndex];
    const now = Date.now();
    const atBottom =
        panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 10;
    const atTop = panel.scrollTop <= 10;

    if (now - lastWheelAt > 300) wheelTotal = 0;
    lastWheelAt = now;

    if (atBottom && event.deltaY > 0) {
        wheelTotal += event.deltaY;
        if (wheelTotal > 200) {
            nextSlide();
            wheelTotal = 0;
            lockSlides();
        }
    } else if (atTop && event.deltaY < 0) {
        wheelTotal += Math.abs(event.deltaY);
        if (wheelTotal > 200) {
            previousSlide();
            wheelTotal = 0;
            lockSlides();
        }
    } else {
        wheelTotal = 0;
    }
}

function stepDial(direction) {
    const lineage = getPlainLineage();
    const versions = lineage.versions || [];

    if (!versions.length) return false;

    const currentIndex = currentVersionIndex(lineage);
    const nextIndex = clamp(currentIndex + direction, 0, versions.length - 1);

    if (nextIndex === currentIndex) return false;

    dialFocusIndex = nextIndex;
    selectVersion(versions[nextIndex].id);
    versionSwitcher?.classList.add("is-scrolling");
    window.clearTimeout(dialScrollTimer);
    dialScrollTimer = window.setTimeout(() => {
        versionSwitcher?.classList.remove("is-scrolling");
    }, 360);
    return true;
}

function onDialWheel(event) {
    const lineage = getPlainLineage();
    const versions = lineage.versions || [];

    if (versions.length < 2) return;

    event.preventDefault();
    event.stopPropagation();

    if (!versionSwitcher?.classList.contains("is-open")) {
        setDialOpen(true);
    }

    const now = Date.now();
    const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;

    if (!delta) return;
    if (now - lastDialWheelAt > 220) dialWheelTotal = 0;

    lastDialWheelAt = now;
    dialWheelTotal += delta;

    const lineMode =
        typeof WheelEvent !== "undefined" &&
        event.deltaMode === WheelEvent.DOM_DELTA_LINE;
    const threshold = lineMode ? 3 : 42;

    if (Math.abs(dialWheelTotal) >= threshold) {
        stepDial(Math.sign(dialWheelTotal));
        dialWheelTotal = 0;
    }
}

function onTouchStart(event) {
    const panel = panels[activeIndex];
    touchStartY = event.touches[0].clientY;
    touchStartScroll = panel.scrollTop;
}

function onTouchEnd(event) {
    if (slideLocked) return;

    const panel = panels[activeIndex];
    const delta = touchStartY - event.changedTouches[0].clientY;
    const startedAtBottom =
        touchStartScroll + panel.clientHeight >= panel.scrollHeight - 10;
    const startedAtTop = touchStartScroll <= 10;

    if (delta > 120 && startedAtBottom) {
        nextSlide();
        lockSlides();
    } else if (delta < -120 && startedAtTop) {
        previousSlide();
        lockSlides();
    }
}

function fitRevealCard(link) {
    const card = link.querySelector(".reveal-card");

    if (!card) return;

    card.style.setProperty("--reveal-nudge", "0px");

    window.requestAnimationFrame(() => {
        const padding = 14;
        const rect = card.getBoundingClientRect();
        let nudge = 0;

        if (rect.left < padding) {
            nudge += padding - rect.left;
        }

        if (rect.right + nudge > window.innerWidth - padding) {
            nudge += window.innerWidth - padding - (rect.right + nudge);
        }

        card.style.setProperty("--reveal-nudge", `${Math.round(nudge)}px`);
    });
}

function findVersionIndexForSignal(versions, signal) {
    const key = contributorKey(signal.handle);
    const stableId = normalizeVersionId(signal.versionId, signal.handle);

    return versions.findIndex((version) => {
        return (
            version.id === signal.versionId ||
            version.id === stableId ||
            (key &&
                version.id !== BASE_VERSION_ID &&
                contributorKey(version.contributor) === key)
        );
    });
}

function addSignal(signal, status, metadata = {}) {
    mutateLineage((lineage) => {
        const existingSignal = lineage.signals.find((item) => item.id === signal.id);
        const existingVersionIndex = findVersionIndexForSignal(
            lineage.versions,
            signal,
        );
        const nextSignal = {
            ...signal,
            ...metadata,
            status,
            versionId: normalizeVersionId(
                metadata.versionId || signal.versionId,
                signal.handle,
            ),
        };
        const nextVersion = signalToVersion(
            nextSignal,
            status,
        );

        if (existingSignal) {
            Object.entries(nextSignal).forEach(([key, value]) => {
                if (value !== undefined && value !== "") existingSignal[key] = value;
            });
        } else {
            lineage.signals.push(nextSignal);
        }

        if (existingVersionIndex !== -1) {
            const existingVersion = lineage.versions[existingVersionIndex];
            Object.entries(nextVersion).forEach(([key, value]) => {
                existingVersion[key] = value;
            });
        } else {
            lineage.versions.push(nextVersion);
        }

        if (status !== "failed") lineage.currentVersion = nextVersion.id;
    });
}

async function submitSignal(signal) {
    const response = await fetch(SIGNAL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signal),
    });

    if (!response.ok) {
        throw new Error(`Signal endpoint returned ${response.status}`);
    }

    return response.json();
}

function mergePublishedLineage(published) {
    const current = getPlainLineage();
    lineageDoc = Automerge.from(mergeLineages(seedLineage, current, published));
    automergeReady = true;
    persistLineage();
    renderLineage();
}

function stopPolling() {
    if (!activePollTimer) return;
    window.clearTimeout(activePollTimer);
    activePollTimer = null;
}

function pollForSignal(signal, attempt = 0) {
    stopPolling();

    activePollTimer = window.setTimeout(async () => {
        const published = await fetchPublishedLineage();
        if (published) {
            mergePublishedLineage(published);
            const plain = getPlainLineage();
            const publishedSignal = (plain.signals || []).find(
                (item) => item.id === signal.id,
            );
            const status = publishedSignal
                ? signalStatus(publishedSignal, plain)
                : "generating";

            if (status === "merged" || status === "failed") {
                if (status === "merged") selectVersion(signal.versionId);
                stopPolling();
                return;
            }
        }

        if (attempt + 1 < POLL_ATTEMPTS) {
            pollForSignal(signal, attempt + 1);
        } else {
            stopPolling();
        }
    }, attempt === 0 ? 1500 : POLL_INTERVAL_MS);
}

panels.forEach((panel) => {
    panel.addEventListener("wheel", onWheel, { passive: true });
    panel.addEventListener("touchstart", onTouchStart, { passive: true });
    panel.addEventListener("touchend", onTouchEnd, { passive: true });
});

tabs.forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(Number(tab.dataset.slide)));
});

document.addEventListener("mouseover", (event) => {
    const link = event.target.closest?.(".reveal-link");
    if (link) fitRevealCard(link);
});

document.addEventListener("focusin", (event) => {
    const link = event.target.closest?.(".reveal-link");
    if (link) fitRevealCard(link);
});

document.addEventListener(
    "touchstart",
    (event) => {
        const link = event.target.closest?.(".reveal-link");
        if (link) fitRevealCard(link);
    },
    {
        passive: true,
    },
);

versionHandle?.addEventListener("click", (event) => {
    event.stopPropagation();
    setDialOpen(!versionSwitcher?.classList.contains("is-open"));
});

versionSwitcher?.addEventListener("wheel", onDialWheel, { passive: false });

versionDial?.addEventListener("click", (event) => {
    const link = event.target.closest("[data-version-link]");

    if (!link) return;

    event.preventDefault();
    event.stopPropagation();
    selectVersion(link.dataset.versionLink);
    setDialOpen(false);
});

document.addEventListener("click", (event) => {
    if (!versionSwitcher || versionSwitcher.contains(event.target)) return;
    setDialOpen(false);
});

versionList?.addEventListener("click", (event) => {
    const link = event.target.closest("[data-version-link]");

    if (!link) return;

    event.preventDefault();
    selectVersion(link.dataset.versionLink);
});

feedbackForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const text = feedbackText.value.trim();
    if (!text) return;

    const idSuffix = Date.now().toString(36);
    const handle = normalizeHandle(feedbackHandle.value);
    const source = currentVersion();
    const existingVersion = getPlainLineage().versions.find(
        (version) =>
            version.id !== BASE_VERSION_ID &&
            contributorKey(version.contributor) === contributorKey(handle),
    );
    const signal = {
        id: `signal-${idSuffix}`,
        versionId: existingVersion?.id || versionIdForHandle(handle),
        handle,
        section: feedbackSection.value,
        text,
        sourceVersion: source?.id || BASE_VERSION_ID,
        visitorId: ensureVisitorId(),
        language: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        url: window.location.href,
        createdAt: new Date().toISOString(),
    };

    addSignal(signal, "queued");

    try {
        const result = await submitSignal(signal);
        addSignal(signal, "generating", {
            statusUrl: result.statusUrl,
            versionId: result.versionId || signal.versionId,
        });
        pollForSignal({ ...signal, versionId: result.versionId || signal.versionId });
    } catch (error) {
        addSignal(signal, "failed", {
            message: error.message || "Signal endpoint failed.",
        });
    }

    feedbackForm.reset();
});

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setDialOpen(false);

    if (
        versionSwitcher?.classList.contains("is-open") &&
        ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)
    ) {
        event.preventDefault();
        stepDial(event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1);
        return;
    }

    if (event.key === "ArrowDown" || event.key === "PageDown") {
        nextSlide();
        lockSlides();
    }

    if (event.key === "ArrowUp" || event.key === "PageUp") {
        previousSlide();
        lockSlides();
    }
});

ensureVisitorId();
setActiveTab(0);
renderLineage();
initLineage();
requestAnimationFrame(() => track.classList.add("is-ready"));
