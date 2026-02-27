#!/usr/bin/env node
import fs from "node:fs/promises";

function parseArgs(argv) {
  const out = { headers: {} };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--endpoint") ((out.endpoint = next), (i += 1));
    else if (a === "--cookie-file") ((out.cookieFile = next), (i += 1));
    else if (a === "--api-key") ((out.apiKey = next), (i += 1));
    else if (a === "--employer-key") ((out.employerKey = next), (i += 1));
    else if (a === "--ctk") ((out.ctk = next), (i += 1));
    else if (a === "--operation-name") ((out.operationName = next), (i += 1));
    else if (a === "--query-file") ((out.queryFile = next), (i += 1));
    else if (a === "--variables-file") ((out.variablesFile = next), (i += 1));
    else if (a === "--variables-json") ((out.variablesJson = next), (i += 1));
    else if (a === "--referer") ((out.referer = next), (i += 1));
    else if (a === "--client-sub-app") ((out.clientSubApp = next), (i += 1));
    else if (a === "--client-sub-app-component") ((out.clientSubAppComponent = next), (i += 1));
    else if (a === "--out") ((out.out = next), (i += 1));
    else if (a === "--header") {
      const v = next || "";
      const idx = v.indexOf("=");
      if (idx > 0) out.headers[v.slice(0, idx)] = v.slice(idx + 1);
      i += 1;
    } else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  return `Usage:\n  graphql-request.mjs --endpoint <url> --cookie-file <cookies.json> --api-key <key> --operation-name <name> --query-file <query.graphql> [options]\n\nOptions:\n  --employer-key <key>\n  --ctk <token>\n  --variables-file <vars.json>\n  --variables-json '<json>'\n  --referer <url>\n  --client-sub-app <name>\n  --client-sub-app-component <name>\n  --header 'Key=Value'        (repeatable)\n  --out <path>                write response JSON to file\n\nEnv fallbacks:\n  INDEED_GRAPHQL_ENDPOINT, INDEED_COOKIE_FILE, INDEED_API_KEY, INDEED_EMPLOYER_KEY, INDEED_CTK\n`;
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

  const endpoint = args.endpoint || process.env.INDEED_GRAPHQL_ENDPOINT;
  const cookieFile = args.cookieFile || process.env.INDEED_COOKIE_FILE;
  const apiKey = args.apiKey || process.env.INDEED_API_KEY;
  const employerKey = args.employerKey || process.env.INDEED_EMPLOYER_KEY;
  const ctk = args.ctk || process.env.INDEED_CTK;

  if (!endpoint || !cookieFile || !apiKey || !args.operationName || !args.queryFile) {
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
  const query = await fs.readFile(args.queryFile, "utf8");

  let variables = {};
  if (args.variablesFile) variables = JSON.parse(await fs.readFile(args.variablesFile, "utf8"));
  if (args.variablesJson) variables = JSON.parse(args.variablesJson);

  const headers = {
    accept: "*/*",
    "content-type": "application/json",
    "indeed-api-key": apiKey,
    ...(employerKey ? { "indeed-employer-key": employerKey } : {}),
    ...(ctk ? { "indeed-ctk": ctk } : {}),
    ...(args.referer ? { referer: args.referer } : {}),
    ...(args.clientSubApp ? { "indeed-client-sub-app": args.clientSubApp } : {}),
    ...(args.clientSubAppComponent
      ? { "indeed-client-sub-app-component": args.clientSubAppComponent }
      : {}),
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
    ...args.headers,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationName: args.operationName,
      variables,
      query,
    }),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  const output = {
    ok: res.ok,
    status: res.status,
    operationName: args.operationName,
    body,
  };

  const pretty = JSON.stringify(output, null, 2) + "\n";
  if (args.out) {
    await fs.writeFile(args.out, pretty, "utf8");
    console.log(args.out);
  } else {
    process.stdout.write(pretty);
  }

  if (!res.ok || body?.errors?.length) process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
