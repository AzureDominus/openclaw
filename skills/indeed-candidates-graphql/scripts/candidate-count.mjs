#!/usr/bin/env node
import fs from "node:fs/promises";
import { resolveIndeedAuthConfig } from "./indeed-config.mjs";

function parseArgs(argv) {
  const out = { headers: {} };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--endpoint") ((out.endpoint = n), (i += 1));
    else if (a === "--cookie-file") ((out.cookieFile = n), (i += 1));
    else if (a === "--api-key") ((out.apiKey = n), (i += 1));
    else if (a === "--employer-key") ((out.employerKey = n), (i += 1));
    else if (a === "--ctk") ((out.ctk = n), (i += 1));
    else if (a === "--status") ((out.status = n), (i += 1));
    else if (a === "--created-after") ((out.createdAfter = Number(n)), (i += 1));
    else if (a === "--submission-type") ((out.submissionType = n), (i += 1));
    else if (a === "--hosted-job-statuses") ((out.hostedJobStatuses = n), (i += 1));
    else if (a === "--milestones") ((out.milestones = n), (i += 1));
    else if (a === "--json") out.json = true;
    else if (a === "--referer") ((out.referer = n), (i += 1));
    else if (a === "--client-sub-app") ((out.clientSubApp = n), (i += 1));
    else if (a === "--client-sub-app-component") ((out.clientSubAppComponent = n), (i += 1));
    else if (a === "--header") {
      const v = n || "";
      const idx = v.indexOf("=");
      if (idx > 0) out.headers[v.slice(0, idx)] = v.slice(idx + 1);
      i += 1;
    } else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  return `Usage:\n  candidate-count.mjs --endpoint <url> --cookie-file <cookies.json> --api-key <key> [options]\n\nOptions:\n  --status <new|reviewing|all|shortlist|undecided|rejected>\n  --created-after <msEpoch>             (default: 1708992000000)\n  --submission-type <type>              (default: LEGACY)\n  --hosted-job-statuses ACTIVE,PAUSED   (default)\n  --milestones NEW,PENDING              (manual override)\n  --employer-key <key>\n  --ctk <token>\n  --referer <url>\n  --client-sub-app <name>\n  --client-sub-app-component <name>\n  --header 'Key=Value'                  (repeatable)\n  --json                                print full JSON\n\nEnv fallbacks:\n  INDEED_GRAPHQL_ENDPOINT, INDEED_COOKIE_FILE, INDEED_API_KEY, INDEED_EMPLOYER_KEY, INDEED_CTK\n\nAuto config fallback:\n  INDEED_CONFIG_FILE or discovered indeed.config.yaml\n`;
}

function statusProfile(status) {
  const s = String(status || "new").toLowerCase();
  const active = ["NEW", "PENDING", "PHONE_SCREENED", "INTERVIEWED", "OFFER_MADE", "REVIEWED"];
  if (s === "all") return { milestones: active };
  if (s === "new") return { milestones: ["NEW", "PENDING"] };
  if (s === "reviewing" || s === "reviewed") return { milestones: ["REVIEWED"] };
  if (s === "rejected") return { milestones: ["REJECTED"] };
  if (s === "shortlist") return { milestones: active, sentiments: ["YES"] };
  if (s === "undecided") return { milestones: active, sentiments: ["MAYBE"] };
  return { milestones: ["NEW", "PENDING"] };
}

function isCookieValid(c) {
  if (!c) return false;
  if (!c.expires || c.expires <= 0) return true;
  return c.expires * 1000 > Date.now();
}

function domainMatch(host, domainRaw) {
  const domain = String(domainRaw || "")
    .replace(/^\./, "")
    .toLowerCase();
  const h = host.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

function pathMatch(reqPath, cookiePath) {
  const p = cookiePath || "/";
  return reqPath.startsWith(p);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const resolved = await resolveIndeedAuthConfig({
    endpoint: args.endpoint || process.env.INDEED_GRAPHQL_ENDPOINT,
    cookieFile: args.cookieFile || process.env.INDEED_COOKIE_FILE,
    apiKey: args.apiKey || process.env.INDEED_API_KEY,
    employerKey: args.employerKey || process.env.INDEED_EMPLOYER_KEY,
    ctk: args.ctk || process.env.INDEED_CTK,
    referer: args.referer,
    clientSubApp: args.clientSubApp,
    clientSubAppComponent: args.clientSubAppComponent,
  });

  const { endpoint, cookieFile, apiKey, employerKey, ctk } = resolved;
  const referer = resolved.referer;
  const clientSubApp = resolved.clientSubApp;
  const clientSubAppComponent = resolved.clientSubAppComponent;

  if (!endpoint || !cookieFile || !apiKey) {
    console.error("Missing required args.\n");
    console.error(usage());
    process.exit(2);
  }

  const endpointUrl = new URL(endpoint);
  const cookiesPayload = JSON.parse(await fs.readFile(cookieFile, "utf8"));
  const cookieList = (cookiesPayload?.cookies || []).filter(
    (c) =>
      isCookieValid(c) &&
      domainMatch(endpointUrl.hostname, c.domain) &&
      pathMatch(endpointUrl.pathname || "/", c.path || "/") &&
      (!c.secure || endpointUrl.protocol === "https:"),
  );
  const cookieHeader = cookieList.map((c) => `${c.name}=${c.value}`).join("; ");

  const profile = statusProfile(args.status);
  const milestones = args.milestones
    ? String(args.milestones)
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : profile.milestones;

  const filter = {
    submissionType: args.submissionType || "LEGACY",
    created: {
      createdAfter: Number.isFinite(args.createdAfter) ? args.createdAfter : 1708992000000,
    },
    jobs: {
      hostedJobPostStatuses: String(args.hostedJobStatuses || "ACTIVE,PAUSED")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    hiringMilestones: { milestoneIds: milestones },
  };

  if (profile.sentiments?.length) {
    filter.sentiments = { sentiments: profile.sentiments };
  }

  const query = `query CandidateListTotalCount($input: FindCandidateSubmissionsInput!, $first: Int) {
  findCandidateSubmissions(input: $input, first: $first) {
    totalCount
    __typename
  }
}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      "indeed-api-key": apiKey,
      ...(employerKey ? { "indeed-employer-key": employerKey } : {}),
      ...(ctk ? { "indeed-ctk": ctk } : {}),
      ...(referer ? { referer } : {}),
      ...(clientSubApp ? { "indeed-client-sub-app": clientSubApp } : {}),
      ...(clientSubAppComponent
        ? { "indeed-client-sub-app-component": clientSubAppComponent }
        : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...args.headers,
    },
    body: JSON.stringify({
      operationName: "CandidateListTotalCount",
      variables: { input: { filter } },
      query,
    }),
  });

  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }
  const count = body?.data?.findCandidateSubmissions?.totalCount;
  const out = {
    ok: res.ok && !body?.errors?.length,
    status: res.status,
    statusFilter: args.status || "new",
    count,
    errors: body?.errors || null,
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(String(count ?? "null"));
  }

  if (!out.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
