#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function stripQuotes(value) {
  const v = String(value || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseSimpleYaml(text) {
  const out = {};
  let section = null;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "    ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = line.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (!out[section]) out[section] = {};
      continue;
    }

    const nestedMatch = line.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (nestedMatch && section) {
      const key = nestedMatch[1];
      const value = stripQuotes(nestedMatch[2]);
      out[section][key] = value;
      continue;
    }

    const topLevelMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (topLevelMatch) {
      const key = topLevelMatch[1];
      const value = stripQuotes(topLevelMatch[2]);
      out[key] = value;
    }
  }

  return out;
}

async function findExistingFile(paths) {
  for (const p of paths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

async function loadIndeedCliConfig(configFileHint) {
  const candidates = [
    configFileHint,
    process.env.INDEED_CONFIG_FILE,
    path.resolve(process.cwd(), "indeed.config.yaml"),
    path.resolve(process.cwd(), "../indeed-cli/indeed.config.yaml"),
    path.join(os.homedir(), "repos/indeed-cli/indeed.config.yaml"),
    "/home/admin/repos/indeed-cli/indeed.config.yaml",
    path.join(os.homedir(), ".config/indeed-cli/indeed.config.yaml"),
  ].filter(Boolean);

  const configPath = await findExistingFile(candidates);
  if (!configPath) return { configPath: null, config: null };

  const raw = await fs.readFile(configPath, "utf8");
  const parsed = parseSimpleYaml(raw);
  return { configPath, config: parsed };
}

export async function resolveIndeedAuthConfig(input = {}) {
  const { configFileHint } = input;
  const { configPath, config } = await loadIndeedCliConfig(configFileHint);

  const endpoint = input.endpoint || config?.graphql?.endpoint || null;
  const apiKey = input.apiKey || config?.graphql?.apiKey || null;
  const employerKey = input.employerKey || config?.graphql?.employerKey || null;
  const ctk = input.ctk || config?.graphql?.ctk || null;
  const referer = input.referer || config?.graphql?.referer || null;
  const clientSubApp = input.clientSubApp || config?.graphql?.clientSubApp || null;
  const clientSubAppComponent =
    input.clientSubAppComponent || config?.graphql?.clientSubAppComponent || null;

  let cookieFile = input.cookieFile || config?.auth?.cookiesFile || null;
  if (cookieFile && !path.isAbsolute(cookieFile) && configPath) {
    cookieFile = path.resolve(path.dirname(configPath), cookieFile);
  }

  return {
    endpoint,
    cookieFile,
    apiKey,
    employerKey,
    ctk,
    referer,
    clientSubApp,
    clientSubAppComponent,
    configPath,
  };
}
