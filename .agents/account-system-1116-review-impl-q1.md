# 账号系统 · 开工期规格裁定 q1（iron-session 装不进来）

> 审核者：代诊-报告（独立审核者，只读）。被审对象：`account-system-1116-plan.md` **v0.8** 的 D2「留（首选会话）= iron-session」在**当前环境**下的可执行性。
> 未改计划/代码、未提交、未动 `data/`、**未安装任何包**；只做 `ls` / `node -e` / `npm view`。**只写了本文件**。

---

## 0. 结论：选 **(B) vendored 独立安装**；`(A) 自写密码学`排最后；另补一个你没列的 **(C)**，它是 B 失败时的首选退路

| 选项 | 我的裁定 | 一句话理由 |
|---|---|---|
| **(B)** `npm i --prefix vendor iron-session@9.1.0` + 单一 seam 文件 + 启动自检 | ✅ **推荐** | **不改变任何已过审的设计**（组件、版本、10 条小样、D0 的撤销语义全部不动），只改"包装在哪"；实测 `vendor/` 装法完全不碰根 `node_modules` 软链 |
| **(C)** 改用 `node:sqlite` 的 `sessions` 表（r1 的"方案 B 有状态会话"） | 🟡 **B 失败时的首选退路** | 零新依赖（`lib/blobStore.mjs:4` 已在用 `DatabaseSync`）、**不用手写密码学**；代价是重开 r1 的"二选一"（P0-5）、多一张表 + 过期清理，需轻量复审 |
| **(A)** 用 Node 内置 `crypto` 自写等效 sealed cookie | 🔴 **不推荐，且必须走偏离记录 + 轻量复审** | 把**审过的组件**换成**没人审的密码学代码**；而且你描述的"等价"在算法层不成立（见 §3） |

**给"开工 gate"的口径（你特别问的那条，一句话版）**：

> **换"装在哪里"不算偏离，换"用哪个组件"才算。** `(B)` 属前者——只需在计划里补一行安装方式 + 5 条取证断言，**不必重审**；`(A)`/`(C)` 属后者——它们是**对 D2 结论的替换**，必须写一段「方案偏离记录」（改了什么、为什么、10 条小样里哪些作废、哪些重写）并由我出一份 addendum 级复审，**不重开整轮**。

---

## 1. 环境取证（我实测的，不是推测）

| 事实 | 证据 |
|---|---|
| 根 `node_modules` 是**软链** | `ls -ld node_modules` → `node_modules -> /Users/scallion/Documents/projects/MedData/node_modules` |
| MedBrief 侧解析不到 iron-session | `node -e "require.resolve('iron-session')"` → `NOT FOUND: MODULE_NOT_FOUND` |
| MedData 侧也没有（连传递依赖都没有） | `ls ../MedData/node_modules \| grep -i "iron\|^cookie$"` → **空** |
| 项目自身依赖极少 | `package.json` 只有 `playwright@^1.50.0`，`type: module` |
| **registry 可达**（能装） | `npm view iron-session@9.1.0 version dependencies` → `9.1.0`；`dependencies = { cookie: '^2.0.1', 'iron-webcrypto': '^2.0.0' }` |
| 体积很小、纯 JS 无编译 | unpacked：iron-session **102 KB** + cookie **~60 KB** + iron-webcrypto **36 KB** ≈ **200 KB** |
| 入口可路径直达 | `npm view iron-session@9.1.0 exports` → `{ '.': './dist/index.js' }` |
| **`.gitignore:1` 是裸 `node_modules`** | 裸模式匹配任意层级 ⇒ `vendor/node_modules` **自动被忽略**，不需要新增忽略规则 |
| 已有先例目录 | `tools/`（含 `bootstrap-accounts.mjs` 等）、`meddata/`（本地源码目录） |

⇒ 结论：**技术上装得进来，且不必碰 MedData**。

---

## 2. (B) 的可执行步骤（照抄即可）

```bash
cd /Users/scallion/Documents/projects/MedBrief

# ① 建一个独立的 vendor 根（不写根 node_modules）
mkdir -p vendor
cat > vendor/package.json <<'JSON'
{ "name": "medbrief-vendor", "private": true, "type": "module",
  "dependencies": { "iron-session": "9.1.0" } }
JSON

# ② 按精确版本装到 vendor/（--prefix 把安装树钉在 vendor/，不碰软链）
npm i --prefix vendor --no-audit --no-fund
#   → vendor/node_modules/{iron-session,cookie,iron-webcrypto}
#   → vendor/package-lock.json（版本锁，务必入库）

# ③ 唯一 seam 文件（将来换回正式依赖只改这一行）
cat > lib/session/index.mjs <<'JS'
export * from '../../vendor/node_modules/iron-session/dist/index.js'
JS

# ④ 启动自检（缺包必须明确报错退出，不许静默降级）
node -e "import('./vendor/node_modules/iron-session/dist/index.js')
  .then(m=>{const need=['sealData','unsealData','getIronSession'];const miss=need.filter(k=>!(k in m));
    if(miss.length){console.error('iron-session 导出缺失:',miss);process.exit(1)}
    console.log('session dep OK')})
  .catch(e=>{console.error('缺少 iron-session：请跑 npm i --prefix vendor（见 README）');process.exit(1)})"
```

**入库规则（写死，二选一）**：入 **`vendor/package.json` + `vendor/package-lock.json` + `tools/check-session-dep.mjs`**；**不入** `vendor/node_modules`（`.gitignore:1` 的裸 `node_modules` 已覆盖）。README 加两句：本仓库的第三方会话依赖装在 `vendor/`，**根 `node_modules` 是 MedData 的软链，永久禁止在根 `npm i`**。

---

## 3. (A) 的三个问题：不是"能不能做"，是"做了要付什么"

### 3.1 你描述的"等价"在算法层不成立（这点必须纠）

写的是「AES-GCM + HMAC，等价 iron-session 的 `sealData`/`unsealData`」。实测取证：

- `npm view iron-session@9.1.0 dependencies` → 依赖 **`iron-webcrypto@^2.0.0`**；
- `iron-webcrypto` 自述：**"WebCrypto-based implementation of `@hapi/iron`"**、**"Compatible API with `@hapi/iron`"**。

`@hapi/iron` 的封包是 **AES-256-CBC + HMAC-SHA256**（`Fe26.*` 前缀的紧凑串），**不是 AES-GCM**。所以自写 AES-GCM 版得到的是**能力等价、格式不同**的东西——这没问题，但：

- 不能写成"等价 iron-session 的 seal"（那是格式声明，会被误读为可互换/可迁移）；
- 一旦格式不同，**将来想换回 iron-session 就是一次全量登出**（旧 cookie 全部解不开），这条要写进方案的升级路径；
- `SESSION_SECRET` **≥32 字符、可轮换成数组（旧 secret 仍能解）** 这个语义，AES-GCM 版要**自己实现**（多 secret 依次尝试），这正是 iron-session 白送的东西。

### 3.2 (A) 会让 10 条小样里的 3 条失去原有意义

原小样第 5（secret 轮换数组）、6（cookie <4096）、9（重启后旧 cookie 有效 + `sessionVersion+1` 后 401）是为 **iron-session 的实现特性**设计的。换成自研后：第 5 条要重写（你实现的轮换是不是"多项尝试"，得有自己的断言）、第 6 条值会变（AES-GCM 密文比 Fe26 短）、第 9 条仍成立但只证明了你的实现。**"小样过了"这个证书在 (A) 下不能直接沿用。**

### 3.3 是否"违背已过审方案"——我的判定

§8 铁律那句是"**『留』的轮子先小样验证**"，它约束的是"**用轮子之前先验**"，**不是"必须用轮子"**。所以：

- 如果环境根本装不了，选 (C)（零依赖、有状态会话）**不算违背铁律**，但它**是对 D2 结论的替换**（r1 的 P0-5 二选一已定案 A）⇒ 需要偏离记录 + 复审；
- 选 (A)（自写密码学）同理，而且**多一层风险**：审过的组件被无人审的代码替代，而"撤销/封包/轮换"三件事恰好是上一轮反复纠的语义处；
- **(B) 不涉及任何一条**——组件、版本、算法、10 条小样全都没变。

---

## 4. 开工 gate（选 B 的话，这 5 条必须绿；任一条红就不许开工）

| Gate | 判据（可复跑） | 为什么它在这里 |
|---|---|---|
| **Q1-G1** | `ls -l node_modules` 仍是 `-> …/MedData/node_modules`；`ls -l ../MedData/node_modules/iron-session` → **ENOENT**；`git status --porcelain` 里**没有** `../MedData` 相关改动 | 防"装着装着把 MedData 依赖树污染了"——这是本条裁定存在的全部理由 |
| **Q1-G2** | `npm ls --prefix vendor --depth=0` 显示 `iron-session@9.1.0`；`vendor/package-lock.json` 里该包版本精确 `9.1.0`（**不是 `^`**） | 版本锁；防 `^9` 漂到行为不同的 9.x |
| **Q1-G3** | `node -e` import seam 文件成功，且导出含 `sealData`/`unsealData`/`getIronSession`（导出名以实际为准，缺哪个报哪个） | 证明"路径直达 + 传递依赖能解析"（`cookie`/`iron-webcrypto` 在 `vendor/node_modules` 同级，Node 向上查找可命中） |
| **Q1-G4** | 10 条小样断言**在 vendor 副本上**至少重跑第 1/4/9 条（无 cookie 401 / cookie 改 1 字节 401 / `sessionVersion+1` 后同一 cookie 401），全绿 | 小样原来在 `/tmp` 的**另一份副本**上跑过——那只证明"这个包能这样用"，不证明"`vendor/` 里的这一份能这样用" |
| **Q1-G5** | 缺包时服务启动**明确报错退出**（`exit 1` + 一句"请跑 npm i --prefix vendor"），**不许**"自动降级成本地实现" | 防将来有人为了省事把 (A) 偷渡进来，把这条裁定作废 |

**若最终走 (C)（SQLite session 表）**：在 5 条 gate 之外再加 2 条——`sessions(token_hash, user_id, created_at, expires_at, revoked_at)` 的**过期清理**有断言（否则表无界增长，与砍 `login_attempts` 时同一条口径）、`revoked_at` 置位后同一 cookie **立刻 401**（这条比 iron-session 的 `sessionVersion` 更强，是真的单会话踢出）。
**若最终走 (A)（自写密码学）**：必须先把 §3.1 的格式差异写进方案，再补 3 条断言——① tamper：改动密文任一字节 ⇒ 401（GCM tag 必须真的在验）；② secret 轮换：`[new, old]` 时旧 cookie 可解、只留 `new` 时旧 cookie 401；③ 明文不可见：cookie 值 base64 解码后**不含** `uid` 字符串。

---

## 5. 无论走哪条路，都必须进 `verify-auth.mjs` 的断言（这份清单从 r1 继承，不能因为换实现而缩水）

1. 无 cookie → 401；2. 三组时序对拍（存在号错密码 / 不存在号 / 锁定期，正文逐字节相同）；3. `/me` 回 role + permissions；4. **cookie 改 1 字节 → 401**；5. `SESSION_SECRET` env 读、≥32 字符、不落 `data/`；6. cookie < 4096 B；7. 同源带 cookie 通过 / `*`+credentials 被拒；8. **原生 `node:http` 下能读写 `mb_session`**（读 `Cookie` 头 + 写 `Set-Cookie`，不用框架中间件）；9. 重启后旧 cookie 有效 **且** `sessionVersion+1` 后同一 cookie 401；10. 限流退避封顶 8s / 第 10 次锁 15 分钟 / 锁满归零。

> 第 8 条在 (B) 下最容易踩：iron-session 的 Node 用法是 `getIronSession(req,res,cookieOptions)`，它内部用 `nodeCookies(req,res)` 读写——**必须确认它在 `createServer` 的原生回调里工作**，不是只认框架的 `res.setHeader` 链。这正是 v0.8 小样第 8 条要证的东西。

---

## 6. 我做了什么 / 没做什么

- 只读：未安装任何包（`npm view` 只查 packument，不落盘）、未改计划/代码、未提交、未动 `data/`。
- **需实现方实测**：§4 的 5 条 gate、`vendor/` 安装是否真的不触碰软链（`ls -l node_modules` 前后比对）、seam 文件的实际导出名。
- 只写了 `.agents/account-system-1116-review-impl-q1.md` 这一个文件。
