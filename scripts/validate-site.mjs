import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
    BASE_VERSION,
    BASE_VERSION_ID,
    contributorKey,
    readJsonFile,
    SIGNAL_STATUSES,
} from "./signal-utils.mjs";

const root = process.cwd();
const lineage = await readJsonFile("data/site-lineage.json");
const errors = [];

function fail(message) {
    errors.push(message);
}

function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function listFiles(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
        const filePath = path.join(dir, name);
        const stats = statSync(filePath);
        return stats.isDirectory() ? listFiles(filePath) : [filePath];
    });
}

if (existsSync("pnpm-lock.yaml")) {
    fail("pnpm-lock.yaml is not allowed; this project must deploy with npm.");
}

const packageJson = await readJsonFile("package.json");
if (String(packageJson.packageManager || "").toLowerCase().includes("pnpm")) {
    fail("package.json must not set packageManager to pnpm.");
}

if (!Array.isArray(lineage.versions)) {
    fail("data/site-lineage.json must contain a versions array.");
}

if (!Array.isArray(lineage.signals)) {
    fail("data/site-lineage.json must contain a signals array.");
}

const versions = Array.isArray(lineage.versions) ? lineage.versions : [];
const signals = Array.isArray(lineage.signals) ? lineage.signals : [];
const base = versions.find((version) => version.id === BASE_VERSION_ID);

if (!base) {
    fail("v1 is missing from data/site-lineage.json.");
} else {
    const baseComparable = {
        id: base.id,
        label: base.label,
        contributor: base.contributor,
        createdAt: base.createdAt,
        summary: base.summary,
        source: base.source,
        locked: base.locked,
        treatment: base.treatment,
    };
    if (!sameJson(baseComparable, BASE_VERSION)) {
        fail("v1 changed; keep the baseline version object immutable.");
    }
    if ("content" in base || "theme" in base || "status" in base) {
        fail("v1 must not receive generated content, theme, or status fields.");
    }
}

const versionIds = new Set();
const contributorKeys = new Map();

for (const version of versions) {
    if (!version?.id) {
        fail("Every version must have an id.");
        continue;
    }

    if (versionIds.has(version.id)) {
        fail(`Duplicate version id: ${version.id}.`);
    }
    versionIds.add(version.id);

    if (version.id !== BASE_VERSION_ID) {
        const key = contributorKey(version.contributor);
        if (!key) {
            fail(`Version ${version.id} must have a contributor handle.`);
        } else if (contributorKeys.has(key)) {
            fail(
                `Contributor ${version.contributor} has multiple versions: ${contributorKeys.get(
                    key,
                )} and ${version.id}.`,
            );
        } else {
            contributorKeys.set(key, version.id);
        }

        if (version.status && !SIGNAL_STATUSES.has(version.status)) {
            fail(`Version ${version.id} has invalid status ${version.status}.`);
        }

        if (version.status === "merged" && !version.content) {
            fail(`Merged version ${version.id} needs version.content.`);
        }
    }
}

if (lineage.currentVersion && !versionIds.has(lineage.currentVersion)) {
    fail(`currentVersion ${lineage.currentVersion} is not present in versions.`);
}

const signalIds = new Set();
for (const signal of signals) {
    if (!signal?.id) {
        fail("Every signal must have an id.");
        continue;
    }

    if (signalIds.has(signal.id)) {
        fail(`Duplicate signal id: ${signal.id}.`);
    }
    signalIds.add(signal.id);

    if (signal.status && !SIGNAL_STATUSES.has(signal.status)) {
        fail(`Signal ${signal.id} has invalid status ${signal.status}.`);
    }

    if (signal.versionId && !versionIds.has(signal.versionId)) {
        const isFailed = signal.status === "failed";
        if (!isFailed) {
            fail(`Signal ${signal.id} points at missing version ${signal.versionId}.`);
        }
    }
}

for (const filePath of listFiles("data/signals")) {
    if (!filePath.endsWith(".json")) continue;
    try {
        JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
        fail(`${filePath} is not valid JSON: ${error.message}`);
    }
}

const staleUiFiles = [
    "index.html",
    "styles.css",
    "src/script-source.js",
    "script.js",
].filter((filePath) => existsSync(filePath));
for (const filePath of staleUiFiles) {
    const text = readFileSync(path.join(root, filePath), "utf8").toLowerCase();
    for (const blocked of ["sequencer", "morph-icon"]) {
        if (text.includes(blocked)) {
            fail(`Stale ${blocked} UI found in ${filePath}.`);
        }
    }
}

if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    throw new Error(`Site validation failed with ${errors.length} error(s).`);
}

console.log("Site validation passed.");
