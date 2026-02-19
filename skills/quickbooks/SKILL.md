---
name: quickbooks
description: Work with QuickBooks Online via the local MCP server named `QuickBooks` (mcporter stdio). Use for tasks like pulling recent expenses/purchases, searching invoices/customers/vendors, creating/updating invoices, bills, customers, and reconciling “what happened in QBO”. Also use to troubleshoot QuickBooks MCP auth issues (headless browser, port 8765 callback, missing/invalid tokens).
---

# QuickBooks (via MCP)

Use the local QuickBooks Online MCP server (`QuickBooks`) through **mcporter**.

## Quick start

### Health check

```bash
mcporter call QuickBooks.health_check --output json
```

### Last 3 expenses (Purchases)

```bash
mcporter call QuickBooks.search_purchases desc:TxnDate limit:3 --output json
```

## Common workflows

### Get “recent expenses” (Purchases)

```bash
mcporter call QuickBooks.search_purchases desc:TxnDate limit:10 --output json
```

### Find invoices

```bash
mcporter call QuickBooks.search_invoices desc:TxnDate limit:10 --output json
```

### List vendors

```bash
mcporter call QuickBooks.search_vendors limit:1000 --output json
```

### Search/list tax codes

```bash
mcporter call QuickBooks.search_tax_codes --output json
```

### Create invoice / customer / vendor

Use `create_invoice`, `create_customer`, `create_vendor` and include an `idempotencyKey` when available.

## Authentication + troubleshooting

Auth is the fragile part. Follow:

- `references/auth.md`

### Auth quickstart (manual/headless)

```bash
mcporter call QuickBooks.oauth_start --output json
mcporter call QuickBooks.oauth_complete redirectUrl:"<PASTE_REDIRECT_URL>" --output json
mcporter call QuickBooks.health_check --output json
```
