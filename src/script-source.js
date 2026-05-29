import * as AutomergeModule from "@automerge/automerge/slim";
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";

await AutomergeModule.initializeBase64Wasm(automergeWasmBase64);

const Automerge = AutomergeModule;

const panels = Array.from(document.querySelectorAll(".slide-panel"));
const slideNames = panels.map((panel) => panel.getAttribute("aria-label") || "");
const track = document.querySelector(".slide-track");
const tabs = Array.from(document.querySelectorAll("[data-slide]"));
const revealLinks = Array.from(document.querySelectorAll(".reveal-link"));
const versionSwitcher = document.querySelector("[data-version-switcher]");
const versionHandle = document.querySelector("[data-version-handle]");
const versionDial = document.querySelector("[data-version-dial]");
const versionList = document.querySelector("#version-list");
const signalLog = document.querySelector("#signal-log");
const feedbackForm = document.querySelector("#feedback-form");
const feedbackHandle = document.querySelector("#feedback-handle");
const feedbackSection = document.querySelector("#feedback-section");
const feedbackText = document.querySelector("#feedback-text");
const automergeStatus = document.querySelector("[data-automerge-status]");

const SIGNAL_ENDPOINT = "/api/site-signal";
const PUBLISHED_LINEAGE_URL = "data/site-lineage.json";
const AUTOMERGE_KEY = "perrin-site-automerge-v1";
const JSON_KEY = "perrin-site-lineage-v1";
const VISITOR_COOKIE = "perrin_site_visitor";
const BASE_VERSION_ID = "v1";
const LEGACY_VERSION_IDS = new Set([
    "base",
    "rami-scroll",
    "bosch-weird",
    "benji-basic-final",
    "benji-feedback-final",
    "benji-signal-loop-final",
]);

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
let slideLocked = false;
let touchStartY = 0;
let touchStartScroll = 0;
let lineageDoc = Automerge.from(clone(seedLineage));
let automergeReady = false;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
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
        originalToStable.set(rawVersion.id, stableId);

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
        return originalToStable.get(id) || id;
    }

    lineages.filter(Boolean).forEach((lineage) => {
        if (lineage.currentVersion) currentCandidate = lineage.currentVersion;

        (lineage.versions || []).forEach(addVersion);

        (lineage.signals || []).forEach((rawSignal) => {
            if (!rawSignal?.id || signalIds.has(rawSignal.id)) return;
            const signal = clone(rawSignal);
            signal.versionId = normalizeVersionId(signal.versionId, signal.handle);
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
    return LEGACY_VERSION_IDS.has(requested) ? BASE_VERSION_ID : requested;
}

function currentVersion(lineage = getPlainLineage()) {
    return (
        lineage.versions.find((version) => version.id === currentVersionId()) ||
        lineage.versions.find((version) => version.id === lineage.currentVersion) ||
        lineage.versions[lineage.versions.length - 1]
    );
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

function setDialOpen(isOpen) {
    if (!versionSwitcher) return;
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

function inferTreatment(text, section) {
    const haystack = `${section} ${text}`.toLowerCase();
    const tone = haystack.match(/quiet|minimal|plain|simple|less|fewer/)
        ? "plain"
        : haystack.match(/green|biology|climate|plant|garden|nature/)
          ? "botanical"
          : haystack.match(/dark|night|black|moody/)
            ? "ink"
            : haystack.match(/image|painting|gallery|visual|bosch/)
              ? "gallery"
              : "plain";
    const imageDensity = haystack.match(/less|fewer|no image|minimal/)
        ? "low"
        : haystack.match(/more image|many image|gallery|visual|bosch/)
          ? "high"
          : "normal";

    return { tone, imageDensity };
}

function signalToVersion(signal, status = "pending") {
    return {
        id: signal.versionId,
        label: `${signal.section} variation`,
        contributor: signal.handle,
        createdAt: signal.createdAt,
        summary: summarize(signal.text),
        source: signal.sourceVersion,
        status,
        treatment: inferTreatment(signal.text, signal.section),
    };
}

function applyVersionTreatment(version) {
    const treatment = version?.treatment || {};
    document.documentElement.dataset.versionTone = treatment.tone || "plain";
    document.documentElement.dataset.imageDensity =
        treatment.imageDensity || "normal";
}

function renderContributorHandle(lineage = getPlainLineage()) {
    const version = currentVersion(lineage);

    if (!versionHandle || !version) return;

    versionHandle.textContent = version.contributor;
    versionHandle.title = `Customized by ${version.contributor}`;
    applyVersionTreatment(version);
}

function renderVersionDial(lineage, activeVersion) {
    if (!versionDial) return;

    versionDial.innerHTML = lineage.versions
        .map((version, index) => {
            const x = -112 - Math.min(index, 5) * 14;
            const y = 52 + index * 44;
            const active = version.id === activeVersion?.id;

            return `
                <button
                    class="version-dial-item"
                    type="button"
                    data-version-link="${escapeHtml(version.id)}"
                    aria-current="${active ? "true" : "false"}"
                    title="${escapeHtml(version.label)} by ${escapeHtml(version.contributor)}"
                    style="--dial-x: ${x}px; --dial-y: ${y}px; --dial-delay: ${index * 34}ms"
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

function renderLineage() {
    const lineage = getPlainLineage();
    const activeVersion = currentVersion(lineage);

    renderContributorHandle(lineage);
    renderVersionDial(lineage, activeVersion);

    if (automergeStatus) {
        automergeStatus.textContent = automergeReady
            ? "Automerge local merge"
            : "Automerge initializing";
    }

    if (versionList) {
        versionList.innerHTML = lineage.versions
            .map((version, index) => {
                const active = version.id === activeVersion?.id ? " aria-current=\"page\"" : "";
                const status = version.status ? ` · ${version.status}` : "";
                return `
                    <li>
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
                        )}${escapeHtml(status)}</p>
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
                      )}: ${escapeHtml(summarize(signal.text))}</li>
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
        mergeLineages(seedLineage, published, savedPlain, savedAutoPlain),
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

function addSignal(signal, status) {
    mutateLineage((lineage) => {
        const existingSignal = lineage.signals.find((item) => item.id === signal.id);
        const existingVersionIndex = findVersionIndexForSignal(
            lineage.versions,
            signal,
        );
        const nextVersion = signalToVersion(
            {
                ...signal,
                versionId: normalizeVersionId(signal.versionId, signal.handle),
            },
            status,
        );

        if (existingSignal) {
            existingSignal.status = status;
        } else {
            lineage.signals.push({ ...signal, status, versionId: nextVersion.id });
        }

        if (existingVersionIndex !== -1) {
            const existingVersion = lineage.versions[existingVersionIndex];
            Object.entries(nextVersion).forEach(([key, value]) => {
                existingVersion[key] = value;
            });
        } else {
            lineage.versions.push(nextVersion);
        }

        lineage.currentVersion = nextVersion.id;
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

panels.forEach((panel) => {
    panel.addEventListener("wheel", onWheel, { passive: true });
    panel.addEventListener("touchstart", onTouchStart, { passive: true });
    panel.addEventListener("touchend", onTouchEnd, { passive: true });
});

tabs.forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(Number(tab.dataset.slide)));
});

revealLinks.forEach((link) => {
    link.addEventListener("mouseenter", () => fitRevealCard(link));
    link.addEventListener("focus", () => fitRevealCard(link));
    link.addEventListener("touchstart", () => fitRevealCard(link), {
        passive: true,
    });
});

versionHandle?.addEventListener("click", (event) => {
    event.stopPropagation();
    setDialOpen(!versionSwitcher?.classList.contains("is-open"));
});

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

    addSignal(signal, "pending");

    try {
        await submitSignal(signal);
        addSignal(signal, "sent");
    } catch {
        addSignal(signal, "local-only");
    }

    feedbackForm.reset();
});

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setDialOpen(false);

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
