const MAX_HTML_BYTES = 1200000;
const REQUEST_TIMEOUT_MS = 5000;
const ALLOWED_HOSTS = new Set([
    "aws.amazon.com",
    "www.apple.com",
    "civicnews.org",
    "cs.duke.edu",
    "www.crisisconnections.org",
    "duke.edu",
    "ece.duke.edu",
    "github.com",
    "www.darpa.mil",
    "www.extellis.com",
    "www.firstinspires.org",
    "www.govgoose.com",
    "www.linkedin.com",
    "www.obama.org",
    "www.taylorswift.com",
    "www.truveta.com",
    "www.ycombinator.com",
]);

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

function cleanText(value, maxLength = 240) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

function decodeHtml(value) {
    return cleanText(value, 1000)
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
            String.fromCharCode(Number.parseInt(code, 16)),
        );
}

function normalizedUrl(value) {
    const url = new URL(String(value || ""));
    url.hash = "";

    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Only HTTP(S) URLs are supported.");
    }

    url.hostname = url.hostname.toLowerCase();

    if (!ALLOWED_HOSTS.has(url.hostname)) {
        throw new Error("Preview host is not allowlisted.");
    }

    return url;
}

function absoluteUrl(value, baseUrl) {
    if (!value) return "";

    try {
        return new URL(value, baseUrl).href;
    } catch {
        return "";
    }
}

function attributes(tag) {
    const output = {};
    const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    for (const match of tag.matchAll(pattern)) {
        output[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
    }
    return output;
}

function metaContent(html, ...names) {
    const wanted = new Set(names.map((name) => name.toLowerCase()));

    for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
        const attrs = attributes(match[0]);
        const key = String(attrs.property || attrs.name || "").toLowerCase();
        if (wanted.has(key) && attrs.content) return decodeHtml(attrs.content);
    }

    return "";
}

function titleContent(html) {
    const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return match ? decodeHtml(match[1]) : "";
}

function iconContent(html, baseUrl) {
    for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
        const attrs = attributes(match[0]);
        const rel = String(attrs.rel || "").toLowerCase();
        if (rel.includes("icon") && attrs.href) {
            return absoluteUrl(attrs.href, baseUrl);
        }
    }

    return absoluteUrl("/favicon.ico", baseUrl);
}

async function limitedText(response) {
    if (!response.body?.getReader) return response.text();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let html = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        received += value.byteLength;
        if (received > MAX_HTML_BYTES) {
            throw new Error("Preview HTML is too large.");
        }
        html += decoder.decode(value, { stream: true });
        if (/<\/head>/i.test(html)) break;
    }

    return html + decoder.decode();
}

function previewFromHtml(html, requestedUrl, finalUrl) {
    const baseUrl = finalUrl || requestedUrl;
    const image = absoluteUrl(
        metaContent(
            html,
            "og:image",
            "og:image:url",
            "twitter:image",
            "twitter:image:src",
        ),
        baseUrl,
    );
    const icon = iconContent(html, baseUrl);
    const canonical = absoluteUrl(
        metaContent(html, "og:url") ||
            html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0]?.match(
                /href=["']([^"']+)["']/i,
            )?.[1],
        baseUrl,
    );

    return {
        ok: true,
        url: requestedUrl.href,
        canonicalUrl: canonical || baseUrl,
        title: metaContent(html, "og:title", "twitter:title") || titleContent(html),
        description: metaContent(
            html,
            "og:description",
            "twitter:description",
            "description",
        ),
        image: image || icon,
        icon,
        siteName: metaContent(html, "og:site_name") || requestedUrl.hostname,
        domain: requestedUrl.hostname.replace(/^www\./, ""),
        source: "open-graph",
    };
}

export default async function handler(req, res) {
    setCors(req, res);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
    }

    if (req.method !== "GET") {
        json(res, 405, { ok: false, error: "Method not allowed." });
        return;
    }

    try {
        const requestedUrl = normalizedUrl(req.query?.url);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let response;

        try {
            response = await fetch(requestedUrl.href, {
                headers: {
                    Accept: "text/html,application/xhtml+xml",
                    "User-Agent": "mysimplewebsite-link-preview/1.0",
                },
                redirect: "follow",
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            throw new Error(`Preview fetch failed with ${response.status}.`);
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.toLowerCase().includes("text/html")) {
            throw new Error("Preview URL did not return HTML.");
        }

        const html = await limitedText(response);
        res.setHeader(
            "Cache-Control",
            "public, max-age=86400, stale-while-revalidate=604800",
        );
        json(res, 200, previewFromHtml(html, requestedUrl, response.url));
    } catch (error) {
        res.setHeader("Cache-Control", "no-store");
        json(res, 400, { ok: false, error: error.message || "Preview failed." });
    }
}
