import path from "node:path";
import {
    actionRunUrl,
    cleanText,
    findVersionForSignal,
    normalizeSignal,
    readJsonFile,
    readLineage,
    signalDir,
    SIGNAL_STATUSES,
    upsertSignalById,
    workflowStatusUrl,
    writeJsonFile,
} from "./signal-utils.mjs";

function parseArgs(argv) {
    const [status, ...rest] = argv;
    const options = {};

    for (let index = 0; index < rest.length; index += 1) {
        const item = rest[index];
        if (!item.startsWith("--")) continue;
        const key = item.slice(2);
        const next = rest[index + 1];
        options[key] = next && !next.startsWith("--") ? next : "true";
        if (options[key] === next) index += 1;
    }

    return { status, options };
}

const { status, options } = parseArgs(process.argv.slice(2));
if (!SIGNAL_STATUSES.has(status)) {
    throw new Error(
        `Status must be one of ${Array.from(SIGNAL_STATUSES).join(", ")}.`,
    );
}

const payloadPath = options.payload || ".signal-payload.json";
const signal = normalizeSignal(await readJsonFile(payloadPath));
signal.versionId = cleanText(options.versionId, signal.versionId);
signal.status = status;
signal.runUrl = cleanText(options["run-url"], signal.runUrl || actionRunUrl());
signal.prUrl = cleanText(options["pr-url"], signal.prUrl);
signal.statusUrl = cleanText(
    options["status-url"],
    signal.statusUrl || workflowStatusUrl(),
);
signal.message = cleanText(options.message, signal.message);

const lineage = await readLineage();
const existingVersion = findVersionForSignal(lineage.versions, signal);
const version = existingVersion || null;

if (status === "merged" && !version) {
    throw new Error(
        `No generated version found for ${signal.handle}; Codex must create it before merge.`,
    );
}

if (version) {
    version.status = status;
    version.runUrl = signal.runUrl;
    version.prUrl = signal.prUrl;
    version.statusUrl = signal.statusUrl;
    if (status === "merged") {
        lineage.currentVersion = version.id;
    }
}

upsertSignalById(lineage.signals, signal);

await writeJsonFile("data/site-lineage.json", lineage);
await writeJsonFile(path.join(signalDir, `${signal.id}.json`), {
    signal,
    ...(version ? { version } : {}),
});

console.log(`Marked ${signal.id} as ${status}`);
