# Google adapters

The only network/storage adapters used by rendering and sign-in. Zero runtime
dependencies; use Node's fetch, filesystem and loopback HTTP server.

| Module | Responsibility |
| --- | --- |
| `auth.js` | Workspace-extension consent URL, loopback/manual login, private token storage, refresh, identity, revocation. |
| `http.js` | Bearer-authenticated JSON calls; at most five attempts on 429/500/502/503/504, with capped exponential backoff. |
| `sheets.js` | Spreadsheet handle, metadata/value reads and chunked formatting/value writes. |

```mermaid
flowchart LR
  Credentials[Access env / token file / refresh env] --> Token[getAccessToken]
  Token --> Identity[Drive about]
  Token --> Sheets[Sheets REST API]
  Token --> Refresh[Workspace extension refresh service]
```

```js
import { getAccessToken } from "./auth.js";
import { sheetsClient } from "./sheets.js";

const token = await getAccessToken();
const client = sheetsClient(spreadsheetId, token);
const meta = await client.get("spreadsheetId,properties(title)");
```

Use `fetchImpl` and `wait` seams in tests. The login callback expires after five
minutes and closes its server; a wrong-domain login is revoked, not stored.
Only Drive scope is requested. Credential priority and environment options are
documented in the root README. No Google client secret is held here.
