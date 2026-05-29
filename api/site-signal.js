const MAX_TEXT_LENGTH = 1200;
const DEFAULT_OWNER = "PerrinMyerson";
const DEFAULT_REPO = "mysimplewebsite";
const BASE_VERSION_ID = "v1";

function json(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}

function setCors(req, res) {
    const allowedOrigin = process.env.ALLOWED_ORIGIN;

    if (!allowedOrigin) return;

    const requestOrigin = req.headers?.origin;
    if (!requestOrigin || requestOrigin === allowedOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    }

    res.setHeader("Vary", "Origin");
}

function cleanText(value, fallback = "") {
    return String(value || fallback)
        .replace(/\s+/g, " ")
        .trim();
}

function cleanHandle(value) {
    const handle = cleanText(value, "@visitor").replace(/[^\w@.-]/g, "");
    return handle.startsWith("@") ? handle.slice(0, 32) : `@${handle.slice(0, 31)}`;
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

function workflowStatusUrl(owner, repo) {
    return `https://github.com/${owner}/${repo}/actions/workflows/site-signal-automerge.yml`;
}

async function readBody(req) {
    if (typeof req.body === "object" && req.body !== null) return req.body;
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");

    let raw = "";
    for await (const chunk of req) raw += chunk;
    return JSON.parse(raw || "{}");
}

function normalizeSignal(body) {
    const text = cleanText(body.text).slice(0, MAX_TEXT_LENGTH);
    if (!text) throw new Error("A customization request is required.");
    const handle = cleanHandle(body.handle);

    const id = cleanText(body.id, `signal-${Date.now().toString(36)}`).replace(
        /[^\w.-]/g,
        "",
    ) || `signal-${Date.now().toString(36)}`;
    const versionId = versionIdForHandle(handle);

    return {
        id,
        versionId,
        handle,
        section: cleanText(body.section, "Whole site").slice(0, 48),
        text,
        sourceVersion: cleanText(body.sourceVersion, BASE_VERSION_ID).slice(0, 80),
        visitorId: cleanText(body.visitorId, "anonymous").slice(0, 128),
        language: cleanText(body.language).slice(0, 24),
        timeZone: cleanText(body.timeZone).slice(0, 64),
        viewport: cleanText(body.viewport).slice(0, 32),
        url: cleanText(body.url).slice(0, 300),
        createdAt: body.createdAt || new Date().toISOString(),
        status: "queued",
    };
}

async function dispatchSignal(signal) {
    const owner = process.env.GITHUB_OWNER || DEFAULT_OWNER;
    const repo = process.env.GITHUB_REPO || DEFAULT_REPO;
    const token = process.env.SITE_SIGNAL_GITHUB_TOKEN || process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error("Missing SITE_SIGNAL_GITHUB_TOKEN.");
    }

    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/dispatches`,
        {
            method: "POST",
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({
                event_type: "site_signal",
                client_payload: { signal },
            }),
        },
    );

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`GitHub dispatch failed: ${response.status} ${detail}`);
    }
}

export default async function handler(req, res) {
    setCors(req, res);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }

    if (req.method !== "POST") {
        json(res, 405, { ok: false, error: "Method not allowed." });
        return;
    }

    try {
        const owner = process.env.GITHUB_OWNER || DEFAULT_OWNER;
        const repo = process.env.GITHUB_REPO || DEFAULT_REPO;
        const signal = normalizeSignal(await readBody(req));
        await dispatchSignal(signal);
        json(res, 202, {
            ok: true,
            signalId: signal.id,
            versionId: signal.versionId,
            status: "queued",
            statusUrl: workflowStatusUrl(owner, repo),
        });
    } catch (error) {
        json(res, 400, { ok: false, error: error.message });
    }
}
