# MedBrief 生产运维手册（2026-11-17 骨架上线；运维维护）

> 执行人：运维。计划依据 `.agents/deploy-1117-plan.md` v0.5e（`42f3b01`）。
> 审核依据：r1–r7（`.agents/deploy-1117-review-r{1..7}.md`），r7 终判 `只准哪几条`——骨架已按条件放行，**数据上线仍硬挂起**。
> 本文件只写**服务器上真实存在的东西**与**可复跑命令**，不写计划里的意图。

---

## 1. 现状（2026-11-17 17:30 实测）

| 项 | 值 |
|---|---|
| 站点 | `https://medbrief.shanhailingjing.top`（HTTP 301 → HTTPS，HTTPS 200） |
| 证书 | Let's Encrypt EC-256，`CN/SAN = medbrief.shanhailingjing.top`（**不与 admin 串证**），有效期至 **2027-02-15**，续期窗口 2027-01-16 |
| 进程 | `medbrief.service`（systemd）→ 监听 **127.0.0.1:5174**，`MemoryMax=768M`，实测 `MemoryCurrent≈82MB` |
| 代码 | 部署 commit `3c1d9c6`（`/api/health` 的 `head` 可自证，`commitSource=env`） |
| 数据 | **空库骨架**：仅 `data/medbrief.db`(账号表) + `data/114-catalog`，**无任何病历** |
| 账号 | 2 个（admin `132****2097` + 报告所有者 `132****0000`），**无开放注册** |
| 主机 | Ubuntu 22.04 / Node v22.20.0(`/opt/node22`) / 盘 20G 可用 / 内存 1.7G 可用 |

---

## 2. 日常操作（全部可复跑）

```bash
# 起停（必须走 systemd，别手搓 node）
sudo systemctl {start|stop|restart|status} medbrief
sudo journalctl -u medbrief -n 50 --no-pager

# 一键验收（11 项机械判定，任一失败退出码 1）
sudo /opt/ops/verify-medbrief.sh 5174

# 健康与版本
curl -s https://medbrief.shanhailingjing.top/api/health | python3 -m json.tool

# 日志
sudo tail -f /opt/1panel/www/sites/medbrief.shanhailingjing.top/log/{access,error}.log
```

**验收脚本查什么**（`/opt/ops/verify-medbrief.sh`）：environ 四开关（`GUAHO_BROWSER=off`/`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`/`MEDBRIEF_BIND=127.0.0.1`/`MB_COOKIE_SECURE=1`）→ 无浏览器进程（`pgrep` + `/proc/<pid>/maps`）→ `flow/start` 被 401 或 `BROWSER_DISABLED` 挡 → `guahao-browser.flag` 不得为 on → bind 只回环 → `health.head == .deploy-commit.commit` + 带外留档一致 → 文件指纹 + dirty 文件等于 HEAD → systemd active/内存/`NRestarts=0` → 未登录 401 ×3 → health 无路径密钥泄露。

---

## 3. 回滚（每步独立）

| 场景 | 操作 |
|---|---|
| 站点挂了/证书错 | 删 `/opt/1panel/www/conf.d/medbrief.shanhailingjing.top.conf` → `docker exec 1Panel-openresty-p1ke openresty -s reload`（**只影响本站，admin/www 不受影响**） |
| 服务崩 | `sudo systemctl restart medbrief`；查 `journalctl -u medbrief`；代码回滚见 §5 |
| 账号误建/误删 | `data/medbrief.db` 每日随 `shanhai-db-backup` 之外**未单独备份**——改动前先 `cp data/medbrief.db /root/ir/medbrief.db.$(date +%F-%H%M)` |

> ⚠️ **本仓库存放在这台有入侵史的机器上**：`/opt/medbrief/data` 目前只有空库，**真实病历投递前必须先完成 6b③ 凭据轮换**（见 §4）。

---

## 4. 数据上线（**硬挂起中**，解锁条件写死）

**前置（缺一不可）**：
1. **6b③ 全机凭据轮换**完成（MySQL root/Redis 同口令 `923229904` 明文在 4 处，其中一处烤在 admin jar 的 `BOOT-INF/classes/application-prod.properties`）；批次见 `/tmp/medbrief-stage0/credential-rotation-runbook.md` 的思路：批 A（`INTERNAL_TOKEN`+`JWT_SECRET`，约 2 分钟）／批 A+B（10 分钟，可能需开发者重打包 admin jar）。
2. **重换 `MB_SESSION_SECRET`**（`/etc/medbrief/medbrief.env`，600，两段各 32 字符）——r7 判词要求：骨架期用过的会话密钥不得带进数据期。
3. **清空骨架期库**：`mv data/medbrief.db /root/ir/medbrief.db.skeleton` 后由首启重建（或删测试账号）。
4. `root@VM-66-189-ubuntu` 公钥处置闭环（已注释禁用，7 天无人认领则删）。

**投递（白名单制，禁止整目录 rsync）**：
```bash
# 只传：reports.json + medbrief.db(blobs) + intake/**，排除 114-auth.json / tmp / backups / 114-flow / *.log
rsync -avz --dry-run --checksum \
  --include='reports.json' --include='medbrief.db' --include='intake/***' --exclude='*' \
  data/ ubuntu@62.234.146.222:/opt/medbrief/data/
# 目标目录 700 / 文件 600；先 dry-run 再 --checksum 核对
```
投完再跑：`node tools/bootstrap-accounts.mjs --apply`（指派 101 条 `report_owners`——**骨架期故意没迁**，因为报告还没上传）+ `sudo /opt/ops/verify-medbrief.sh 5174`。

---

## 5. 代码回滚与重新部署

```bash
# 构建机（Mac）：钉 commit → 打包 → 传 → 落盘
git archive <commit> | tar -x -C /tmp/mb-deliver/medbrief
cp -a web/dist-next .deploy-commit /tmp/mb-deliver/medbrief/
tar -czf medbrief-<commit>.tar.gz -C /tmp/mb-deliver medbrief && shasum -a 256 medbrief-<commit>.tar.gz
scp medbrief-<commit>.tar.gz ubuntu@62.234.146.222:/tmp/
# 服务器：
cd /tmp && sha256sum medbrief-<commit>.tar.gz   # 与上面比对
cp -a /tmp/medbrief/. /opt/medbrief/ && cd /opt/medbrief && npm ci && (cd vendor && npm ci)
sudo sed -i "s/^Environment=MEDBRIEF_COMMIT=.*/Environment=MEDBRIEF_COMMIT=<commit>/" /etc/systemd/system/medbrief.service
sudo systemctl daemon-reload && sudo systemctl restart medbrief
sudo sh -c "echo \"[$(date '+%F %T')] commit=<commit> ...\" >> /root/ir/medbrief-releases.log"
```

**发布留档**：`/root/ir/medbrief-releases.log`（commitFull + distSha256 + 包 sha256 + 站点/证书事件）。
**安全前置留档**：`/root/ir/{ufw-status,iptables-save,ip6tables-save,docker-ps-a,ss-tlnp,ip-a}-*.txt`。
**事件记录**：`/opt/1panel/_archive/20261117/INCIDENT-es-ransomware.txt`（该机 ES 曾被 Meow 类擦库留勒索信 `recover_your_database`）。

---

## 6. 已知偏离与理由（审计口径）

1. **站点未在 1Panel 面板登记**：`/opt/1panel/www/conf.d/medbrief.shanhailingjing.top.conf` 是运维手工落盘的（面板当前无 API key 可用）。**未改 openresty 裸配置、未碰 admin/www**。副作用：面板「网站」列表里看不到本站；1Panel 不会覆盖该文件。要纳管，需面板 API key 后重建。
2. **证书不依赖 1Panel**：acme.sh（`/opt/ops/acme`）+ `--install-cert` 钩子（`docker exec 1Panel-openresty-p1ke openresty -s reload`）+ cron `/etc/cron.d/acme-renew` 每日 03:00。
3. **`data/` 写在 `/opt/medbrief/data`**，systemd `ProtectSystem=strict` + `ReadWritePaths` 已实启验证（`NRestarts=0`，无 EROFS）。

---

## 7. 本期踩过的坑（复现判据）

| 坑 | 判据 |
|---|---|
| `package-lock.json` 含 `"link": true` + `../MedData` 软链 → 服务器装出断链、`ERR_MODULE_NOT_FOUND: playwright` | `grep -c '"link": true' package-lock.json` 必须为 0 |
| `vendor/node_modules` 被 gitignore 但 `lib/auth.mjs:3` 依赖 `iron-session` | 投递后必须 `cd vendor && npm ci` |
| `.deploy-commit` 钉错 commit | `health.head` 必须等于 `.deploy-commit.commit`，且 `commitSource` 如实回显 |
| `pkill -f 'node server.mjs'` 误杀生产 5174 + MedData 8008 | 清端口一律 `lsof -t -iTCP:<port> \| xargs -r kill`，**禁 pkill** |
| nginx `root` 用宿主机路径 → ACME 404 | 容器内路径是 `/www/sites/...`（`/opt/1panel/www` → `/www`） |
