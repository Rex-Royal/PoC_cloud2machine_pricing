# Rex-Royal Cloud-to-Machine Dynamic Pricing — Wire API Reference

This document specifies the **Version 1 wire protocol** for third-party ERP and backend integrations updating prices on connected Rex-Royal coffee machines using standard **ThingsBoard Cloud (`:443`, `/api/...`)** and **FtpProxy (`:8787`, `/api/v2/...`)** REST APIs.

---

## 1. Authentication & HTTP Headers

| Target Service | Base Path | Required Auth Header |
|---|---|---|
| ThingsBoard Cloud (`https://<tbHost>`) | `/api/...` | `X-Authorization: Bearer <jwt>` |
| FtpProxy Storage (`https://<ftpHost>:8787`) | `/api/v2/...` | `Authorization: Bearer <jwt>` |

> [!NOTE]
> The same ThingsBoard JWT authenticates **both** endpoints. In browser environments, `src/app/api-bridge/` proxies calls server-side using `X-Target-Origin` strictly to bypass browser CORS; **backend/server integrations should call ThingsBoard and FtpProxy directly** (`useLocalCorsProxy: false`).

### Login & Token Refresh
- **Sign In**: `POST /api/auth/login`
  ```json
  { "username": "integrator@example.com", "password": "<password>" }
  ```
  Returns `{ "token": "<jwt>", "refreshToken": "<refresh_token>" }`.
- **Refresh Expired/Expiring JWT**: `POST /api/auth/token` (no `X-Authorization` header needed)
  ```json
  { "refreshToken": "<refresh_token>" }
  ```
- **Current User & Customer Scope**: `GET /api/auth/user` -> includes `authority` (`"TENANT_ADMIN"` or `"CUSTOMER_USER"`) and `customerId.id`.

---

## 2. Fleet Discovery

### List Customer Machines & Metadata
`POST /api/entitiesQuery/find` (header: `X-Authorization: Bearer <jwt>`)

```json
{
  "entityFilter": {
    "type": "customerOwner",
    "resolveMultiple": true,
    "customerId": { "id": "<customerId>", "entityType": "CUSTOMER" }
  },
  "pageLink": {
    "pageSize": 250,
    "page": 0,
    "sortOrder": { "key": { "type": "ENTITY_FIELD", "key": "name" }, "direction": "ASC" }
  },
  "entityFields": [
    { "type": "ENTITY_FIELD", "key": "name" },
    { "type": "ENTITY_FIELD", "key": "label" },
    { "type": "ENTITY_FIELD", "key": "type" }
  ],
  "latestValues": [
    { "type": "TIME_SERIES", "key": "cmConnected" },
    { "type": "SERVER_ATTRIBUTE", "key": "lastConnectTime" },
    { "type": "SERVER_ATTRIBUTE", "key": "lastDisconnectTime" },
    { "type": "ATTRIBUTE", "key": "serialNumber" },
    { "type": "ATTRIBUTE", "key": "name" },
    { "type": "ATTRIBUTE", "key": "machineModel" },
    { "type": "ATTRIBUTE", "key": "machineType" },
    { "type": "ATTRIBUTE", "key": "location" },
    { "type": "ATTRIBUTE", "key": "currencySymbol" }
  ]
}
```

- **Device ID**: `row.entityId.id`
- **Online precedence**: Compare timestamps across `TIME_SERIES.cmConnected`, `SERVER_ATTRIBUTE.lastConnectTime`, and `SERVER_ATTRIBUTE.lastDisconnectTime` (`resolveMachineOnlineStatus` in `packages/fleet-sync/src/coffee-machine-service.ts`). Always confirm live reachability with `getTermInfo` before assuming a device can execute a live RPC (see Section 5).

---

## 3. Reading Current Layouts & 32-Parameter Price Mapping

### Read Device `config.json` and `confighash.json`
- `GET /api/v2/download/Config/{deviceId}/config.json` (`Authorization: Bearer <jwt>`, `Cache-Control: no-store`)
- `GET /api/v2/download/Config/{deviceId}/confighash.json` (`Authorization: Bearer <jwt>`)

### Grid Geometry & Slot ID Formula
- Machines store recipes across categories `0..categories-1` using a **24-slot stride per category**:
  ```text
  slotId = positionInCategory + 24 * categoryIndex
  ```
  - Standard touchscreen buttons occupy IDs `1..96`; derived double/XL/grinder cup variants may appear in `extendedCupSize` (`101..989`).
- Each recipe slot carries:
  - `id`: Slot recipe ID (`1..96` or `101..989`)
  - `M0801` / `productType`: Beverage preset ID (e.g. `2` = Coffee, `4` = Espresso, `14` = Cappuccino)
- **Golden Guardrail #2**: Only share one `add_priceList_*.zip` across machines whose `rows`, `columns`, `categories`, and per-slot `M0801` recipe IDs match (`clusterMachinesByLayout` / `validatePriceListAgainstMachine` in `packages/firmware-core`).
- **Golden Guardrail #3 (Minor Units)**: All prices are **unscaled integer minor currency units** (Rappen/Cents: `350` = `3.50 CHF/EUR`, clamped `0..65000`).

### Complete 32-Parameter Mapping (`config.json` <-> `priceList.json`)

| `priceList.json` Key | Enum Constant | `config.json` Attribute Name(s) | Meaning |
|---|---|---|---|
| `"47"` | `C_PL1Gr1_Single` | `M1401` / `PrLi 1 Gr1 single` | Price List 1 — Grinder 1 Single |
| `"48"` | `C_PL1Gr2_Single` | `M1402` / `PrLi 1 Gr2 single` | Price List 1 — Grinder 2 Single |
| `"91"` | `C_PL1Gr3_Single` | `PrLi 1 Gr3 single` / `M1403` | Price List 1 — Grinder 3 Single |
| `"49"` | `C_PL1Decaf_Single` | `M1404` / `PrLi 1 Decaf single` | Price List 1 — Decaf Single |
| `"50"` | `C_PL1Gr1_Double` | `M1406` / `PrLi 1 Gr1 double` | Price List 1 — Grinder 1 Double (`2x`) |
| `"51"` | `C_PL1Gr2_Double` | `M1407` / `PrLi 1 Gr2 double` | Price List 1 — Grinder 2 Double (`2x`) |
| `"92"` | `C_PL1Gr3_Double` | `PrLi 1 Gr3 double` / `M1408` | Price List 1 — Grinder 3 Double (`2x`) |
| `"52"` | `C_PL1Decaf_Double` | `M1409` / `PrLi 1 Decaf double` | Price List 1 — Decaf Double (`2x`) |
| `"53"` | `C_PL2Gr1_Single` | `M1411` / `PrLi 2 Gr1 single` | Price List 2 — Grinder 1 Single |
| `"54"` | `C_PL2Gr2_Single` | `M1412` / `PrLi 2 Gr2 single` | Price List 2 — Grinder 2 Single |
| `"93"` | `C_PL2Gr3_Single` | `PrLi 2 Gr3 single` / `M1413` | Price List 2 — Grinder 3 Single |
| `"55"` | `C_PL2Decaf_Single` | `M1414` / `PrLi 2 Decaf single` | Price List 2 — Decaf Single |
| `"56"` | `C_PL2Gr1_Double` | `M1416` / `PrLi 2 Gr1 double` | Price List 2 — Grinder 1 Double (`2x`) |
| `"57"` | `C_PL2Gr2_Double` | `M1417` / `PrLi 2 Gr2 double` | Price List 2 — Grinder 2 Double (`2x`) |
| `"94"` | `C_PL2Gr3_Double` | `PrLi 2 Gr3 double` / `M1418` | Price List 2 — Grinder 3 Double (`2x`) |
| `"58"` | `C_PL2Decaf_Double` | `M1419` / `PrLi 2 Decaf double` | Price List 2 — Decaf Double (`2x`) |
| `"59"` | `C_PL3Gr1_Single` | `M1421` / `PrLi 3 Gr1 single` | Price List 3 — Grinder 1 Single |
| `"60"` | `C_PL3Gr2_Single` | `M1422` / `PrLi 3 Gr2 single` | Price List 3 — Grinder 2 Single |
| `"95"` | `C_PL3Gr3_Single` | `PrLi 3 Gr3 single` / `M1423` | Price List 3 — Grinder 3 Single |
| `"61"` | `C_PL3Decaf_Single` | `M1424` / `PrLi 3 Decaf single` | Price List 3 — Decaf Single |
| `"62"` | `C_PL3Gr1_Double` | `M1426` / `PrLi 3 Gr1 double` | Price List 3 — Grinder 1 Double (`2x`) |
| `"63"` | `C_PL3Gr2_Double` | `M1427` / `PrLi 3 Gr2 double` | Price List 3 — Grinder 2 Double (`2x`) |
| `"96"` | `C_PL3Gr3_Double` | `PrLi 3 Gr3 double` / `M1428` | Price List 3 — Grinder 3 Double (`2x`) |
| `"64"` | `C_PL3Decaf_Double` | `M1429` / `PrLi 3 Decaf double` | Price List 3 — Decaf Double (`2x`) |
| `"65"`..`"70"`, `"97"`, `"98"` | `C_Code*` | `M1601`..`M1609` / `Code Gr3 *` | Payment / MDB / PLU selection codes |

> [!CAUTION]
> **`priceList.json` Overwrites Unmodified Keys**: Always export all 32 keys per product row (`exportToPriceListJson`) initialized from the machine's current values; omitting Grinder 2/3, Decaf, or Double keys may reset them.

---

## 4. Packaging & Uploading `add_priceList_<layoutKey>.zip`

> [!CAUTION]
> **Golden Guardrail #1 (`add_` Prefix)**: The `.zip` uploaded to FtpProxy **MUST begin with `add_` or `import_`** (e.g., `add_priceList_3x5x1_abc12345.zip`) and contain `priceList.json` directly at the ZIP archive root. Without `add_` / `import_`, firmware executes a destructive full backup restore that removes custom touchscreen icons and layout XML files.

### Stage Archive in Customer `Backup` Scope
`POST /api/v2/upload` (`Authorization: Bearer <jwt>`, `multipart/form-data`)

Form fields:
- `json`: JSON string with **`uid` = `<customerId>`**, `type` = `"Backup"`:
  ```json
  {
    "uid": "<customerId>",
    "type": "Backup",
    "fileId": "pricing-1794211000000",
    "forceUpload": true
  }
  ```
- `file`: binary contents of `add_priceList_<layoutKey>.zip` (`Content-Type: application/zip`)

---

## 5. Dual-Path Delivery (Live RPC vs. Offline `cmdStack.json`)

Because MQTT brokers keep TCP sessions open for up to ~6 minutes after power-off (`cmConnected = true`), always send a fast 2-way liveness check first.

### Step 5a — Live Ping (`getTermInfo`)
`POST /api/rpc/twoway/{deviceId}` (`X-Authorization: Bearer <jwt>`)
```json
{ "method": "getTermInfo", "params": {}, "persistent": false, "timeout": 2500 }
```

### Step 5b (Path A: Awake Machine) — Single-Shot `applyBackup` RPC
1. Clear any older pricing entries in `Config/{deviceId}/cmdStack.json` so the machine does not re-apply on next reboot.
2. Send **one** one-way RPC (**Golden Guardrail #4: never retry in a fast loop**, because UI reload + idle upload takes ~2–3 minutes):
   `POST /api/rpc/oneway/{deviceId}` (`X-Authorization: Bearer <jwt>`)
   ```json
   {
     "method": "applyBackup",
     "params": {
       "customer": "<customerId>",
       "sourceFile": "add_priceList_<layoutKey>.zip",
       "type": "Backup"
     }
   }
   ```

### Step 5b (Path B: Offline / Unreachable Machine) — Queue in `cmdStack.json`
1. Read existing queue (returns `404` when empty):
   `GET /api/v2/download/Config/{deviceId}/cmdStack.json` (`Authorization: Bearer <jwt>`)
2. Frame the `applyBackup` JSON as `<base64(JSON)>||` and append it to any non-duplicate queued commands (`appendCommandToCmdStack`).
3. Upload back using **`uid` = `<deviceId>`** and `type` = `"Config"` (note that `uid` is **`customerId`** for `Backup/*.zip`, but **`deviceId`** for `Config/cmdStack.json`!):
   `POST /api/v2/upload` (`multipart/form-data`)
   - `json`: `{"uid": "<deviceId>", "type": "Config", "fileId": "cmdstack-1794211000000", "forceUpload": true}`
   - `file`: `<base64>||` string (`cmdStack.json`, `Content-Type: application/json`)

On next power-on/MQTT connect, the machine downloads `cmdStack.json`, deletes `cmdStack.json`, pulls `add_priceList_<layoutKey>.zip` from `Backup/`, applies the updated prices, and publishes a new `config.json` + `confighash.json`.

---

## 6. Verification & Backup Cleanup

> [!IMPORTANT]
> **Golden Guardrail #5**: Never write or overwrite `Config/{deviceId}/config.json` from an external client—it is owned exclusively by the coffee machine firmware.

1. Poll `GET /api/v2/list/{deviceId}/Config` or `GET /api/v2/download/Config/{deviceId}/confighash.json` & `config.json` until all target machines reflect the new prices (`doesRawConfigMatchTargetPrices`).
   - Note: `BACKUP_DOWNLOAD_GRACE_MS` (`15_000` ms) in `packages/firmware-core/src/pricing-scheduler.ts` provides a download window once `cmdStack.json` disappears or RPC is sent; in production backends, prefer waiting for `config.json`/`confighash.json` confirmation from every target machine before deleting shared `.zip` archives.
2. Delete the staged archive once all target machines in the batch confirm (and no other active batch shares the filename):
   `DELETE /api/v2/delete` (`Authorization: Bearer <jwt>`, `Content-Type: application/json`)
   ```json
   {
     "uid": "<customerId>",
     "type": "Backup",
     "file": "add_priceList_<layoutKey>.zip"
   }
   ```

> [!NOTE]
> **Browser PoC vs. Production ERP Backend**: In the Next.js studio UI, offline queue watching (`4s` polling), scheduled timers, and `.zip` cleanup run in browser storage while the tab remains open. Production ERP/backend integrations should run queue polling, Happy Hour schedules, and `.zip` cleanup in a persistent server worker/cron job.
