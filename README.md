# Paper Compass

Paper Compass is a local-only stock research and simulated trading dashboard for one shared Alpaca Paper Trading account. The backend is permanently locked to:

`https://paper-api.alpaca.markets`

There is no live-account URL, real-money mode, or live-mode switch in this project.

## Requirements

- Node.js 22 or newer
- An Alpaca Paper Trading account and paper API credentials

## Setup

Open PowerShell in this folder, then run:

```powershell
Copy-Item .env.example .env
notepad .env
```

Enter only the paper credentials:

```dotenv
ALPACA_API_KEY=your_paper_key
ALPACA_SECRET_KEY=your_paper_secret
ALPACA_DATA_FEED=iex
PORT=4317
```

Save the file, close Notepad, then start the backend:

```powershell
npm start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). The dashboard and automatic paper monitoring work only while this backend remains running.

## Verify Paper-Only Connection

Before starting automatic paper trading:

1. Open **Settings** in the dashboard.
2. Confirm **Locked trading endpoint** shows `https://paper-api.alpaca.markets`.
3. Select **Verify paper connection**.
4. Confirm the dashboard reports **Alpaca Paper connected** and shows the endpoint verification time.

You can also inspect the backend status without submitting an order:

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/status | ConvertTo-Json -Depth 6
```

The response must contain:

```json
{
  "paperOnly": true,
  "endpoint": "https://paper-api.alpaca.markets"
}
```

## Paper Modes

- **Paper Manual:** research and account data sync in Paper Compass; simulated orders are placed on Alpaca's website.
- **Paper Auto:** one local worker can submit simulated orders within the saved limits. Starting it requires an explicit confirmation in the dashboard.
- **Pause automatic trading:** stops new automatic orders. It does not cancel pending orders or close positions.

Automatic mode pauses whenever the backend restarts. This prevents an unnoticed restart from resuming order submission.

## Research Boundaries

Opportunity rankings use Alpaca's tradable asset catalog, most-active stock response, and timestamped market snapshots. The displayed score is a rule-based rank, not a probability or performance forecast.

No news or regulatory-filing provider is configured. News, filings, catalysts, and event verification are therefore shown as unavailable and are never invented. The free IEX feed covers IEX rather than every US exchange; the dashboard labels feed coverage and timestamps.

## Secrets and Local Data

- `.env` is excluded from Git.
- Secrets are read by the backend only and are never returned to browser code.
- Saved limits are stored in the ignored `data/` directory.
- The worker lock is stored in the ignored `.runtime/` directory so multiple local backend processes cannot control automatic paper orders simultaneously.
- The 20 dashboard access codes are a convenience gate, not secure authentication. Anyone with local source access can inspect them.

