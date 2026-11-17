#!/bin/bash
# MedBrief 服务器侧发布脚本（由 GitHub Actions 的 deploy.yml 调用；也可人手工跑）
#
# 用法：sudo bash deploy-remote.sh <commit> <entrySha> <distAggSha> [--dry-run]
# 前提：/tmp/medbrief-<commit>.tar.gz（git archive）、/tmp/medbrief-dist-<commit>.tar.gz、
#       /tmp/.deploy-commit 已经 scp 到服务器。
#
# 设计约束（每条都对应一次真实事故）：
#   * 只重启一次；重启前后若产物/代码指纹变了，必须当新版本重走验收（不能只对齐凭证）
#   * 验收红 ⇒ 自动回滚（代码 + dist + 凭证三件套），并把失败原因写进发布日志
#   * 不做 git add / 不改仓库；只动 /opt/medbrief 与 systemd
#   * 任何一步失败都留痕到 /root/ir/medbrief-releases.log，绝不静默
set -uo pipefail

COMMIT="${1:?用法: deploy-remote.sh <commit> <entrySha> <distAggSha> [--dry-run]}"
ENTRY="${2:-unknown}"
AGG="${3:-unknown}"
DRY="${4:-}"

APP=/opt/medbrief
OPS=/opt/ops
NODE=/opt/node22/bin/node
LOG=/root/ir/medbrief-releases.log
TS=$(date +%Y%m%d-%H%M%S)
CODE_TGZ=/tmp/medbrief-$COMMIT.tar.gz
DIST_TGZ=/tmp/medbrief-dist-$COMMIT.tar.gz
CRED=/tmp/.deploy-commit
RB_CODE="$LOG.rollback-code-$TS.tar.gz"
RB_DIST="/root/ir/dist-before-$TS"

say() { echo "[$(date '+%F %T')] $*"; }
die() { say "❌ $*"; exit 1; }

[ "$(id -u)" = "0" ] || die "需要 root（sudo bash $0 ...）"
for f in "$CODE_TGZ" "$DIST_TGZ" "$CRED"; do [ -f "$f" ] || die "缺投递文件：$f"; done

say "== 发布 $COMMIT（entry=$ENTRY，distAgg=$AGG）${DRY:+[DRY-RUN]} =="
[ "$DRY" = "--dry-run" ] && { say "dry-run：只校验文件与当前状态，不改任何东西"; ls -l "$CODE_TGZ" "$DIST_TGZ" "$CRED"; curl -s http://127.0.0.1:5174/api/health; exit 0; }

# ---------- 1) 回滚三件套 ----------
say "== 备份回滚三件套 =="
tar czf "$RB_CODE" -C "$APP" --exclude=./data --exclude=./node_modules --exclude=./logs --exclude=./vendor/node_modules . || die "备份代码树失败"
cp -a "$APP/.deploy-commit" "/root/ir/deploy-commit-before-$TS.json" || true
cp -a "$APP/web/dist-next" "$RB_DIST" || die "备份旧 dist 失败"
cp -a /etc/systemd/system/medbrief.service "/root/ir/medbrief.service-$TS" || true
say "回滚点：$RB_CODE / $RB_DIST / /root/ir/deploy-commit-before-$TS.json"

rollback() {
  say "↩️ 回滚到发布前状态：$*"
  tar xzf "$RB_CODE" -C "$APP" || say "!! 代码回滚失败，需人工"
  rm -rf "$APP/web/dist-next" && cp -a "$RB_DIST" "$APP/web/dist-next" || say "!! dist 回滚失败，需人工"
  [ -f "/root/ir/deploy-commit-before-$TS.json" ] && install -m 600 -o ubuntu -g ubuntu "/root/ir/deploy-commit-before-$TS.json" "$APP/.deploy-commit"
  [ -f "/root/ir/medbrief.service-$TS" ] && cp -a "/root/ir/medbrief.service-$TS" /etc/systemd/system/medbrief.service
  systemctl daemon-reload; systemctl restart medbrief; sleep 3
  echo "[$(date '+%F %T')] ROLLBACK commit=$COMMIT reason=$* 回滚点=$RB_CODE" >> "$LOG"
  curl -s http://127.0.0.1:5174/api/health || true
}

# ---------- 2) 投递 ----------
say "== 投递代码与产物 =="
tar xzf "$CODE_TGZ" -C "$APP" || { rollback "解包代码失败"; exit 1; }
find "$APP" -name "._*" -delete 2>/dev/null || true
rm -rf "$APP/web/dist-next/assets"
tar xzf "$DIST_TGZ" -C "$APP/web/dist-next" || { rollback "解包 dist 失败"; exit 1; }
find "$APP/web/dist-next" -name "._*" -delete 2>/dev/null || true

# ---------- 3) 凭证 + commit 标记 + 只重启一次 ----------
say "== 部署凭证与 commit 标记 =="
install -m 600 -o ubuntu -g ubuntu "$CRED" "$APP/.deploy-commit" || { rollback "写凭证失败"; exit 1; }
CRED_COMMIT=$(python3 -c "import json;print(json.load(open('$APP/.deploy-commit'))['commit'])" 2>/dev/null)
[ "$CRED_COMMIT" = "$COMMIT" ] || { rollback "凭证 commit=$CRED_COMMIT ≠ 投递 commit=$COMMIT"; exit 1; }
sed -i "s/^Environment=MEDBRIEF_COMMIT=.*/Environment=MEDBRIEF_COMMIT=$COMMIT/" /etc/systemd/system/medbrief.service
systemctl daemon-reload
say "== 重启（只一次）=="
systemctl restart medbrief; sleep 3
systemctl is-active --quiet medbrief || { rollback "服务未 active"; exit 1; }

# ---------- 4) 验收（任一红即自动回滚） ----------
say "== 14 项常设验收 =="
if ! bash "$OPS/verify-medbrief.sh" 5174; then rollback "verify-medbrief.sh FAIL"; exit 1; fi
say "== 权限矩阵探针（P12/P13/P14 字节断言）=="
# 探针会建临时账号并还原，必须在 /opt/medbrief 下跑（它按相对路径 import lib/）
if ! (cd "$APP" && $NODE "$OPS/verify-medbrief-authz.mjs"); then rollback "verify-medbrief-authz FAIL"; exit 1; fi

# ---------- 5) 留档 ----------
HEAD_NOW=$(curl -s http://127.0.0.1:5174/api/health | python3 -c "import sys,json;print(json.load(sys.stdin).get('head',''))" 2>/dev/null)
echo "[$(date '+%F %T')] RELEASE(CD) commit=$COMMIT entrySha=$ENTRY distAggSha=$AGG health.head=$HEAD_NOW 验收=14项+authzPASS 回滚点=$RB_CODE" >> "$LOG"
say "✅ 发布完成：head=$HEAD_NOW"
