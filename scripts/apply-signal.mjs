import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const lineagePath = path.resolve("data/site-lineage.json");
const signalDir = path.resolve("data/signals");
const BASE_VERSION_ID = "v1";
const BASE_VERSION = {
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
const LEGACY_VERSION_IDS = new Set([
    "base",
    "rami-scroll",
    "bosch-weird",
    "benji-basic-final",
    "benji-feedback-final",
    "benji-signal-loop-final",
]);

function cleanText(value, fallback = "") {
    return String(value || fallback)
        .replace(/\s+/g, " ")
        .trim();
}

function summarize(text) {
    const clean = cleanText(text);
    return clean.length > 96 ? `${clean.slice(0, 93)}...` : clean;
}

function cleanHandle(value) {
    const handle = cleanText(value, "@visitor").replace(/[^\w@.-]/g, "");
    return handle.startsWith("@") ? handle.slice(0, 32) : `@${handle.slice(0, 31)}`;
}

function contributorKey(value) {
    return cleanText(value).toLowerCase();
}

function versionIdForHandle(handle) {
    const slug = cleanText(handle, "visitor")
        .toLowerCase()
        .replace(/^@/, "")
        .replace(/[^a-z0-9_.-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48);

    return `custom-${slug || "visitor"}`;
}

function normalizeSourceVersion(value) {
    const id = cleanText(value, BASE_VERSION_ID).slice(0, 80);
    return LEGACY_VERSION_IDS.has(id) ? BASE_VERSION_ID : id;
}

function inferTreatment(text, section) {
    const haystack = `${section} ${text}`.toLowerCase();
    const tone = haystack.match(
        /stickyjams|sticky jams|cam scoglio|football|wrestling|sports|helmet/,
    )
        ? "sport"
        : haystack.match(/quiet|minimal|plain|simple|less|fewer/)
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
        : haystack.match(
              /more image|many image|gallery|visual|bosch|stickyjams|sticky jams|football|wrestling|sports/,
          )
          ? "high"
          : "normal";

    return { tone, imageDensity };
}

function normalizeSignal(payload) {
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

function unwrapPayload(payload) {
    return payload?.signal && typeof payload.signal === "object"
        ? payload.signal
        : payload;
}

async function readLineage() {
    const raw = await readFile(lineagePath, "utf8");
    const lineage = JSON.parse(raw);
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

function upsertSignalById(items, next) {
    const index = items.findIndex((item) => item.id === next.id);
    if (index === -1) {
        items.push(next);
        return;
    }

    items[index] = { ...items[index], ...next };
}

function upsertVersionByContributor(versions, next) {
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

function versionFromSignal(signal) {
    return {
        id: signal.versionId,
        label: `${signal.section} variation`,
        contributor: signal.handle,
        createdAt: signal.createdAt,
        summary: summarize(signal.text),
        source: signal.sourceVersion,
        status: "merged",
        treatment: inferTreatment(signal.text, signal.section),
    };
}

function prBody(signal, version) {
    return [
        "Automerged site signal.",
        "",
        `Contributor: ${signal.handle}`,
        `Section: ${signal.section}`,
        `Source version: ${signal.sourceVersion}`,
        `Generated version: ${version.id}`,
        "",
        "Request:",
        "",
        signal.text,
    ].join("\n");
}

const payload = process.env.SIGNAL_PAYLOAD
    ? JSON.parse(process.env.SIGNAL_PAYLOAD)
    : JSON.parse(process.argv[2] || "{}");
const signal = normalizeSignal(unwrapPayload(payload));

if (!signal.text) {
    throw new Error("Signal text is required.");
}

const lineage = await readLineage();
const version = versionFromSignal(signal);
upsertSignalById(lineage.signals, { ...signal, status: "merged" });
upsertVersionByContributor(lineage.versions, version);
lineage.currentVersion = version.id;

await mkdir(signalDir, { recursive: true });
await writeFile(lineagePath, `${JSON.stringify(lineage, null, 2)}\n`);
await writeFile(
    path.join(signalDir, `${signal.id}.json`),
    `${JSON.stringify({ signal, version }, null, 2)}\n`,
);
await writeFile(".signal-branch-name", `codex/site-signal-${signal.id}\n`);
await writeFile(".signal-pr-title", `Site signal: ${version.label}\n`);
await writeFile(".signal-pr-body.md", `${prBody(signal, version)}\n`);

console.log(`Generated ${version.id} from ${signal.id}`);
