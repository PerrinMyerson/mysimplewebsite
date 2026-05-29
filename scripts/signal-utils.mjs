import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const lineagePath = path.resolve("data/site-lineage.json");
export const signalDir = path.resolve("data/signals");
export const BASE_VERSION_ID = "v1";
export const BASE_VERSION = {
    id: BASE_VERSION_ID,
    label: "Version 1",
    contributor: "@perrinmyerson + Codex",
    createdAt: "2026-05-28",
    summary:
        "Preserved baseline: plain white article pages with hover notes, Bosch image studies, feedback, and version lineage.",
    source: "",
    locked: true,
    treatment: { tone: "plain", imageDensity: "normal" },
};
export const LEGACY_VERSION_IDS = new Set([
    "base",
    "rami-scroll",
    "bosch-weird",
    "benji-basic-final",
    "benji-feedback-final",
    "benji-signal-loop-final",
]);
export const SIGNAL_STATUSES = new Set([
    "queued",
    "generating",
    "merged",
    "failed",
]);

export function cleanText(value, fallback = "") {
    return String(value || fallback)
        .replace(/\s+/g, " ")
        .trim();
}

export function summarize(text, maxLength = 96) {
    const clean = cleanText(text);
    return clean.length > maxLength
        ? `${clean.slice(0, maxLength - 3)}...`
        : clean;
}

export function cleanHandle(value) {
    const handle = cleanText(value, "@visitor").replace(/[^\w@.-]/g, "");
    return handle.startsWith("@") ? handle.slice(0, 32) : `@${handle.slice(0, 31)}`;
}

export function contributorKey(value) {
    return cleanText(value).toLowerCase();
}

export function versionIdForHandle(handle) {
    const slug = cleanText(handle, "visitor")
        .toLowerCase()
        .replace(/^@/, "")
        .replace(/[^a-z0-9_.-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48);

    return `custom-${slug || "visitor"}`;
}

export function normalizeSourceVersion(value) {
    const id = cleanText(value, BASE_VERSION_ID).slice(0, 80);
    return LEGACY_VERSION_IDS.has(id) ? BASE_VERSION_ID : id;
}

export function unwrapPayload(payload) {
    return payload?.signal && typeof payload.signal === "object"
        ? payload.signal
        : payload;
}

export function normalizeSignal(payload) {
    const createdAt = payload.createdAt || new Date().toISOString();
    const handle = cleanHandle(payload.handle);
    const id =
        cleanText(payload.id, `signal-${Date.now().toString(36)}`).replace(
            /[^\w.-]/g,
            "",
        ) || `signal-${Date.now().toString(36)}`;
    const versionId = versionIdForHandle(handle);

    return {
        id,
        versionId,
        handle,
        section: cleanText(payload.section, "Whole site").slice(0, 48),
        text: cleanText(payload.text).slice(0, 1200),
        sourceVersion: normalizeSourceVersion(payload.sourceVersion),
        visitorId: cleanText(payload.visitorId, "anonymous").slice(0, 128),
        language: cleanText(payload.language).slice(0, 24),
        timeZone: cleanText(payload.timeZone).slice(0, 64),
        viewport: cleanText(payload.viewport).slice(0, 32),
        url: cleanText(payload.url).slice(0, 300),
        createdAt,
    };
}

export async function readJsonFile(filePath, fallback = null) {
    try {
        return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
        if (fallback !== null && error.code === "ENOENT") return fallback;
        throw error;
    }
}

export async function writeJsonFile(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readLineage() {
    const lineage = await readJsonFile(lineagePath, {
        currentVersion: BASE_VERSION_ID,
        versions: [],
        signals: [],
    });

    lineage.versions = (lineage.versions || []).filter(
        (version) => version?.id && !LEGACY_VERSION_IDS.has(version.id),
    );
    if (!lineage.versions.some((version) => version.id === BASE_VERSION_ID)) {
        lineage.versions.unshift(BASE_VERSION);
    }
    lineage.versions = lineage.versions.map((version) =>
        version.id === BASE_VERSION_ID
            ? { ...BASE_VERSION, ...version, id: BASE_VERSION_ID, locked: true }
            : version,
    );
    lineage.signals ||= [];
    return lineage;
}

export function upsertSignalById(items, next) {
    const index = items.findIndex((item) => item.id === next.id);
    if (index === -1) {
        items.push(next);
        return;
    }

    items[index] = { ...items[index], ...next };
}

export function findVersionForSignal(versions, signal) {
    const key = contributorKey(signal.handle);
    return versions.find((version) => {
        return (
            version.id === signal.versionId ||
            (key &&
                version.id !== BASE_VERSION_ID &&
                contributorKey(version.contributor) === key)
        );
    });
}

export function upsertVersionByContributor(versions, next) {
    if (next.id === BASE_VERSION_ID) return;

    const key = contributorKey(next.contributor);
    let index = versions.findIndex((version) => version.id === next.id);

    if (key) {
        const contributorIndex = versions.findIndex(
            (version) =>
                version.id !== BASE_VERSION_ID &&
                contributorKey(version.contributor) === key,
        );
        if (contributorIndex !== -1) index = contributorIndex;
    }

    if (index === -1) {
        versions.push(next);
        index = versions.length - 1;
    } else {
        versions[index] = { ...versions[index], ...next, id: next.id };
    }

    if (!key) return;

    for (let itemIndex = versions.length - 1; itemIndex >= 0; itemIndex -= 1) {
        if (
            itemIndex !== index &&
            versions[itemIndex].id !== BASE_VERSION_ID &&
            contributorKey(versions[itemIndex].contributor) === key
        ) {
            versions.splice(itemIndex, 1);
        }
    }
}

export function versionShellFromSignal(signal, status = "queued") {
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

export function actionRunUrl() {
    const server = process.env.GITHUB_SERVER_URL || "https://github.com";
    const repository = process.env.GITHUB_REPOSITORY;
    const runId = process.env.GITHUB_RUN_ID;
    return repository && runId ? `${server}/${repository}/actions/runs/${runId}` : "";
}

export function workflowStatusUrl() {
    const server = process.env.GITHUB_SERVER_URL || "https://github.com";
    const repository = process.env.GITHUB_REPOSITORY || "PerrinMyerson/mysimplewebsite";
    return `${server}/${repository}/actions/workflows/site-signal-automerge.yml`;
}
