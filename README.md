# 吞吞大乱斗

一款原创的"吞噬成长"类网页游戏：吃掉比你小的，躲开比你大的，和真人玩家抢排行榜第一。

- **单机版（GitHub Pages）**：https://fuzzylogic112.github.io/blob-brawl/
- **联机服务器（Render）**：部署后地址为 `https://tuntun-brawl.onrender.com`（以 Render 控制台显示的为准）

两个地址都能进联机大厅；单机模式不需要服务器。

## 部署到自己的服务器（推荐国内玩家使用）

适用于 Debian 11/12、Ubuntu 20.04 以上，1 核 1G 内存、3 Mbps 带宽起步。

1. 域名解析：添加一条 **A 记录**，主机记录 `game`，记录值填服务器公网 IP
2. 云服务器安全组：入方向放行 **80** 和 **443** 端口
3. 用 root 登录服务器，执行：

```bash
curl -fsSL https://fuzzylogic112.github.io/blob-brawl/install.sh | bash -s -- game.xwj0.cn
```

脚本会安装 Node.js、Nginx，注册开机自启的 `tuntun-brawl` 服务，并自动申请 HTTPS 证书。完成后打开 `https://game.xwj0.cn` 就能玩。以后想更新到最新版，重新执行同一条命令即可。

GitHub Pages 上的页面会先连 `game.xwj0.cn`，连不上时自动改连 Render 备用服务器。

常用命令：`systemctl status tuntun-brawl`（状态）、`journalctl -u tuntun-brawl -f`（日志）。

发布新版本安装包：`bash deploy/build.sh`，把 `dist/` 里的两个文件放到 gh-pages 分支根目录。

## 一键部署到 Render（海外免费）

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/FuzzyLogic112/blob-brawl)

1. 点上面的按钮，用 GitHub 账号登录 Render
2. 确认页面上的服务 `tuntun-brawl`（免费套餐、新加坡机房），点页面底部的部署按钮
3. 等 2～3 分钟部署完成，打开服务地址就能玩

免费套餐说明：15 分钟没人玩会自动休眠，下次有人打开时需要 30～60 秒唤醒，游戏里会显示等待提示。有人在玩时不会休眠。

## 玩法

- 移动吃掉地图上的彩色豆子，慢慢变大
- 质量比对方大 15% 才能吃掉对方，并且要把对方大半个身子罩住；个头越大，移动越慢
- 对手名字是**绿色**的你能吃，**红色**的能吃掉你，白色的差不多大
- **分身**：一分为二，小球向前冲刺，用来突袭或逃命；一段时间后自动合体
- **吐球**：吐出一小块质量，可以喂队友、诱敌，或者喂刺球
- **加速**：按住后速度提升约 65%，满能量能冲约 2 秒；能量用完后要松开再按才能继续冲，停止加速 1 秒后开始恢复，约 7 秒回满。加速中的球身后会拖出残影，AI 也会用加速逃跑和追击
- **刺球**（绿色锯齿球）：小球可以躲在下面；大球撞上会被炸成碎块；往刺球里吐 7 次球，它会朝吐球方向射出一个新刺球

## 模式

| 模式 | 说明 |
| --- | --- |
| 联机对战 | 所有真人在同一个大厅，人少时由 AI 补位（排行榜里带 AI 标记） |
| 单机经典 | 和 26 个 AI 对战，被吃就结束 |
| 单机限时 | 3 分钟内尽量长大，可以复活，时间到按质量排名 |

## 操作

| 平台 | 移动 | 分身 | 吐球 | 加速 | 暂停 |
| --- | --- | --- | --- | --- | --- |
| 电脑 | 鼠标 | 空格 | 按住 W | 按住 Shift 或鼠标左键 | Esc / P |
| 手机 | 左手按住屏幕拖动（浮动摇杆） | 右下角「分身」 | 按住「吐球」 | 按住「加速」 | 顶部暂停键 |

## 技术结构

```
public/index.html   前端：渲染、输入、菜单、单机模式、联机客户端
public/sim.js       游戏逻辑：物理、吞噬、分身、刺球、AI（浏览器和服务器共用）
server/server.js    联机服务器：Node.js + ws，服务器权威模拟
render.yaml         Render 部署配置
deploy/             自有服务器的一键安装脚本和打包脚本
test/               规则测试和服务器测试（npm test）
```

- 服务器以 40Hz 运行模拟，每秒向每位玩家推送 20 次二进制快照，只包含玩家视野内的球
- 豆子只在进入大厅时全量发送一次，之后只同步增减
- 客户端每秒上报 20 次鼠标/摇杆方向，画面做平滑插值
- 连接数、消息频率、昵称长度都有限制，服务器没人时自动暂停模拟

## 本地运行

```bash
npm install
npm start
# 打开 http://localhost:8080
```

GitHub Pages 上的页面默认连接 `wss://tuntun-brawl.onrender.com/ws`。如果 Render 分配的地址不同，可以改 `public/index.html` 里的 `DEFAULT_SERVER`，或者在网址后面加 `?server=你的地址.onrender.com` 临时指定。

GitHub Pages 从 `gh-pages` 分支发布，内容就是 `public/` 目录。

## 说明

玩法参考了经典的吞噬类游戏，但名称、美术、代码均为原创，与任何商业游戏无关。

## License

MIT
