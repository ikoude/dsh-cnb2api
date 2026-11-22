# 发布 dsh-cnb2api

三种分发方式。**本地目录**给自己，**GitHub** 给别人（推荐），**npm** 用户端最省事。

## 0. 发布前检查

- [ ] `package.json` 的 `version` 已 bump（当前见该文件）
- [ ] `npm test` 全绿
- [ ] 仓库里**没有令牌**（令牌在用户自己的 `~/.dsh/.../cordis.patch.yml`，不该进仓库）
- [ ] `package.json` 的 `repository` / `homepage` / `bugs` 指向真实仓库
- [ ] `engines.dsh` 与实际支持的 DSH 版本一致（现在是 `>=0.2.2-rc.5`）

## 1. 本地目录（只给自己 / 同机）

DSH 界面：**插件 → 添加插件 → 选择本地目录**。

或用 `plugin_manager` 的 `install_bundle`，`target` 传这个包目录的**绝对路径**。

**改动后要重新安装**（`set_bundle(false)` 再 `set_bundle(true)`，版本变了则 `remove_bundle` + `install_bundle`）。

## 2. GitHub（推荐）

```bash
git init && git add -A && git commit -m "dsh-cnb2api <版本>"
git remote add origin git@github.com:<OWNER>/dsh-cnb2api.git
git push -u origin main
git rev-parse HEAD          # 记下这 40 位 commit
```

安装 spec **必须钉完整 40 位 commit**，分支/tag 不行（会被标成 `not-updatable`）：

```
git+https://github.com/<OWNER>/dsh-cnb2api#<40位commit>
```

界面：**插件 → 添加插件** 填上面这串；或让 agent 用 `install_bundle` 装。

升级：推到新 commit 后，用新 sha 的 spec 再装一次（`updateBundle` 对 git 包也要 spec）。

## 3. npm

```bash
npm publish                 # 先确认包名未被占用
npm view dsh-cnb2api version
```

安装：`dsh-cnb2api@<版本>`。

## 4. 上架「发现」页（插件市场）

市场读的是一份 **索引 JSON**（format 1）。用脚本生成，不要手写 —— `name`/`version`/`engines`
必须与 `package.json` 一致，`title`/`description` 直接复用 `locale/*.json`，git 源还会强制校验
40 位 commit。

```bash
# git 源（已有 git 仓库时自动取 remote 与 HEAD）
node scripts/market-index.mjs --repo https://github.com/<OWNER>/dsh-cnb2api

# npm 源
node scripts/market-index.mjs --repo https://github.com/<OWNER>/dsh-cnb2api --type npm
```

产出 `market-index.json`。把它托管到可公开访问的 URL（GitHub Pages、jsDelivr raw、
gist raw 均可），用户在 **设置 → 插件市场 → 索引** 里添加该 URL。

> 条目详情页（`docs/DETAIL.md` 与 `preview.svg`）由市场从**公开**仓库读取；
> 私有仓库的详情图不会显示。

## 5. 上架公共市场（让所有人不用手动加索引）

DSH 没有全局插件目录；「发现」页只搜索**用户自己配置的索引**。要让大家都能搜到，
需要给公共索引的上游提交条目：

- 公共索引：`realguan/dsh-plugin-market`（你本机已配置）
- 条目来源：`awesome-dsh-plugin/awesome-dsh-plugin` 的 `data/plugins/<owner>__<repo>.yml`
- 市场索引每天 03:17 UTC 从上游重建；GitHub Pages 地址约 10 分钟生效，jsDelivr 最长 12 小时

投稿文件已备好：`contrib/ikoude__dsh-cnb2api.yml`（只提交这**一个**文件，不要改生成的 README）。

提交前确认：

- [ ] GitHub 仓库创建满 **1 天**（CI 自动检查，不足会被拒）
- [ ] 仓库 Added topics 里加上 **`dsh-plugin`**
- [ ] `package.json` 有 `dsh.bundle`（已有）
- [ ] 描述与代码一致、不带营销词（已按此写）

步骤：fork `awesome-dsh-plugin` → 把 contrib 里的文件放到 `data/plugins/` → 提 PR → 等 CI + 维护者审阅。

## 6. 验证安装

装完在 **插件** 页确认 `CNB2API` 这一行的开关已打开，然后：

1. 打开插件详情页，确认状态面板与网关信息正常；
2. **设置 → 模型** 里确认出现 `CNB2API`（路由 `cnb-gateway`）；
3. 新开会话选它，发一句话确认能收到回复。

命令行侧可先确认网关可用：

```bash
curl -s http://127.0.0.1:41729/v1/models \
  -H "Authorization: Bearer <插件页显示的访问密钥>"
```
