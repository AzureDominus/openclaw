#!/usr/bin/env node
import fs from "node:fs/promises";
import { resolveIndeedAuthConfig } from "./indeed-config.mjs";

function parseArgs(argv) {
  const out = { dryRun: false, headers: {} };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--endpoint") ((out.endpoint = n), (i += 1));
    else if (a === "--cookie-file") ((out.cookieFile = n), (i += 1));
    else if (a === "--api-key") ((out.apiKey = n), (i += 1));
    else if (a === "--employer-key") ((out.employerKey = n), (i += 1));
    else if (a === "--ctk") ((out.ctk = n), (i += 1));
    else if (a === "--status") ((out.status = n), (i += 1));
    else if (a === "--candidate-submission-id") ((out.candidateSubmissionId = n), (i += 1));
    else if (a === "--job-id") ((out.jobId = n), (i += 1));
    else if (a === "--referer") ((out.referer = n), (i += 1));
    else if (a === "--client-sub-app") ((out.clientSubApp = n), (i += 1));
    else if (a === "--client-sub-app-component") ((out.clientSubAppComponent = n), (i += 1));
    else if (a === "--header") {
      const v = n || "";
      const idx = v.indexOf("=");
      if (idx > 0) out.headers[v.slice(0, idx)] = v.slice(idx + 1);
      i += 1;
    } else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  return `Usage:\n  update-candidate-status.mjs --endpoint <url> --cookie-file <cookies.json> --api-key <key> --status <shortlist|undecided|rejected> --candidate-submission-id <id> [options]\n\nOptions:\n  --job-id <id>                         required for rejected\n  --employer-key <key>\n  --ctk <token>\n  --referer <url>\n  --client-sub-app <name>\n  --client-sub-app-component <name>\n  --header 'Key=Value'                  (repeatable)\n  --dry-run\n\nEnv fallbacks:\n  INDEED_GRAPHQL_ENDPOINT, INDEED_COOKIE_FILE, INDEED_API_KEY, INDEED_EMPLOYER_KEY, INDEED_CTK\n\nAuto config fallback:\n  INDEED_CONFIG_FILE or discovered indeed.config.yaml\n`;
}

function sentimentFor(status) {
  const s = String(status || "").toLowerCase();
  if (s === "shortlist") return "YES";
  if (s === "undecided") return "MAYBE";
  if (s === "rejected") return "NO";
  throw new Error(`Unsupported status: ${status}`);
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

async function gql(endpoint, headers, operationName, variables, query) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ operationName, variables, query }),
  });
  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }
  return { ok: res.ok && !body?.errors?.length, status: res.status, body };
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

  if (!endpoint || !cookieFile || !apiKey || !args.status || !args.candidateSubmissionId) {
    console.error("Missing required args.\n");
    console.error(usage());
    process.exit(2);
  }

  if (String(args.status).toLowerCase() === "rejected" && !args.jobId) {
    throw new Error("--job-id is required when --status rejected");
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

  const baseHeaders = {
    accept: "*/*",
    "content-type": "application/json",
    "indeed-api-key": apiKey,
    ...(employerKey ? { "indeed-employer-key": employerKey } : {}),
    ...(ctk ? { "indeed-ctk": ctk } : {}),
    ...(referer ? { referer } : {}),
    ...(clientSubApp ? { "indeed-client-sub-app": clientSubApp } : {}),
    ...(clientSubAppComponent ? { "indeed-client-sub-app-component": clientSubAppComponent } : {}),
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
    ...args.headers,
  };

  const sentiment = sentimentFor(args.status);

  const sentimentVars = {
    sentimentInput: {
      candidateSubmissionIds: [args.candidateSubmissionId],
      sentiment,
    },
  };

  const sentimentQuery = `mutation UpdateCandidateSentimentAndStatus($sentimentInput: CreateEmployerCandidateSubmissionFeedbackInput!) {
  createEmployerCandidateSubmissionFeedback(input: $sentimentInput) {
    feedback {
      id
      __typename
    }
    __typename
  }
}`;

  const ops = [
    {
      operationName: "UpdateCandidateSentimentAndStatus",
      variables: sentimentVars,
      query: sentimentQuery,
    },
  ];

  if (String(args.status).toLowerCase() === "rejected") {
    ops.push({
      operationName: "UpdateCandidateSubmissionMilestoneList",
      variables: {
        input: {
          move: {
            milestoneId: "REJECTED",
            candidateSubmissionEmployerJobIdPairs: [
              {
                candidateSubmissionId: args.candidateSubmissionId,
                jobId: args.jobId,
              },
            ],
          },
        },
      },
      query: `mutation UpdateCandidateSubmissionMilestoneList($input: UpdateCandidateSubmissionMilestoneInput!) {
  updateCandidateSubmissionMilestone(input: $input) {
    candidateSubmissionList {
      id
      __typename
    }
    __typename
  }
}`,
    });
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ dryRun: true, status: args.status, ops }, null, 2));
    process.exit(0);
  }

  const results = [];
  for (const op of ops) {
    const r = await gql(endpoint, baseHeaders, op.operationName, op.variables, op.query);
    results.push({ op: op.operationName, ...r });
    if (!r.ok) {
      console.log(JSON.stringify({ ok: false, results }, null, 2));
      process.exit(1);
    }
  }

  console.log(JSON.stringify({ ok: true, status: args.status, results }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
