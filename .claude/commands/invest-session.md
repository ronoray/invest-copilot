Run the following steps in order to orient this session for invest-copilot work:

**Step 1 — Health check (parallel):**
Call these MCP tools simultaneously:
- mcp__invest__health_check
- mcp__invest__portfolio_list
- mcp__invest__signal_list with portfolioId=3

**Step 2 — Read context files:**
Read these files (in parallel):
- C:/invest-copilot/.claude/INVEST_COPILOT_KNOWLEDGE.md (first 80 lines for stack + architecture)
- C:/Users/ronor/.claude/projects/C--Hungry-Times-Webapp/memory/invest_copilot_hardening.md
- C:/Users/ronor/.claude/projects/C--Hungry-Times-Webapp/memory/invest_copilot_architecture.md

**Step 3 — Render session brief:**

Output exactly this layout:

---
## Invest Copilot Session — [HH:MM IST]

**Health:** API UP/DOWN | DB connected/error | Telegram bot polling/stopped
**Portfolio (Rono - Upstox):** ₹X invested · ₹X current · P&L +/-₹X (+/-X%)
**Cash available:** ₹X
**Holdings:** list each symbol, qty, P&L%
**Signals:** N pending — list each (symbol, side, status)

**Key Gotchas (always apply):**
- MARKET for confidence ≥85, LIMIT within 0.5% of LTP for confidence 78-84
- effectiveCash = rawCash minus reserved (PENDING/SNOOZED BUY signals reserve cash)
- SELL signals expire automatically when holding detected as sold externally
- External sells → Telegram notification sent inline by syncUpstoxHoldings
- Auto-deploy: git push → GitHub webhook → invest-api rebuild (no manual pull)
- SSH: `ssh -i ~/.ssh/id_claude_code rono@64.227.137.98`, files at /opt/invest-copilot
- DB: PostgreSQL via Prisma, docker-internal only (no host port)

**Open Bugs:**
- Upstox post-OAuth redirect error (see memory/invest_upstox_auth_redirect_bug.md)

**What needs attention:** [list any signals PENDING, any service DOWN, any error]
---
