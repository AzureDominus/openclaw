import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

export function registerWebhooksCli(program: Command) {
  const webhooks = program
    .command("webhooks")
    .description("Webhook helpers and integrations")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/webhooks", "docs.openclaw.ai/cli/webhooks")}\n`,
    );

  const gmail = webhooks.command("gmail").description("Deprecated Gmail Pub/Sub watcher helpers");

  const failRemovedGmailWatcherCommand = () => {
    defaultRuntime.error(
      danger(
        [
          "Gmail Pub/Sub setup and runner commands were removed with the legacy watcher flow.",
          "OpenClaw still accepts POST /hooks/gmail from an external ingestor.",
          `Docs: ${formatDocsLink("/automation/webhook", "docs.openclaw.ai/automation/webhook")}`,
        ].join("\n"),
      ),
    );
    defaultRuntime.exit(1);
  };

  gmail
    .command("setup")
    .description("Removed: legacy Gmail Pub/Sub setup")
    .action(failRemovedGmailWatcherCommand);

  gmail
    .command("run")
    .description("Removed: legacy Gmail Pub/Sub runner")
    .action(failRemovedGmailWatcherCommand);
}
