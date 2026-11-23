# LAPLACE SC Relay

适用于 Chrome 和 Edge 的第三方扩展。在 LAPLACE Chat 的单房间控制台点击 SC 卡片的纸飞机，即可用 Chat 当前账号把正文转为普通弹幕。

## 安装和连接（Windows x64）

1. 下载或克隆仓库，运行项目根目录的 [Install-SC-Relay.cmd](Install-SC-Relay.cmd)。它会下载并校验官方 Event Bridge 服务端、启动本机桥接、写入插件的连接配置并打开 Chrome 扩展管理页。使用 Edge 时运行 `Install-SC-Relay.cmd -Browser Edge`。
2. 在扩展管理页开启开发者模式，选择「加载已解压的扩展程序」，选中 `laplace-sc-relay` 文件夹。需要保留原来的扩展 ID 和设置时，将新版扩展文件更新到原安装路径后点「重新加载」。从新路径加载会创建新的扩展 ID。 [Chrome 加载说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) · [扩展 ID 与加载路径](https://developer.chrome.com/docs/extensions/mv2/architecture-overview#referring-to-files)
3. 刷新 Chat 控制台。先确认 Chat 已登录且左侧显示原生弹幕发送框。插件使用该发送框和 Chat 当前账号。 [LAPLACE 发送设置](https://laplace.live/settings)
4. 点 **SC 栏齿轮**打开插件设置，查看桥接状态并点击「复制桥接密码」。打开 **Chat 原生齿轮 → Event Bridge 集成**，填主机 `127.0.0.1`、端口 `9696` 和该密码，点击「连接」。若使用自定义端口，按插件设置显示的端口填写。可开启 Chat 的页面载入时自动连接。 [Event Bridge 官方文档](https://laplace.live/chat/event-bridge)
5. 插件设置显示「本房间收到 … 条弹幕」后，即可留空 Chat 的原生发送框，点击纸飞机转发。

Windows 重启后可运行 `Start-SC-Event-Bridge.cmd` 恢复本机服务。已配置的密码会继续使用。自建本机桥接可在插件的「自定义桥接端口或密码」中填写连接信息。

## 转发规则

- 前后缀默认是 `【` 和 `】`。长文优先按标点分段，每段单独加前后缀。默认单条 20 字符，分段间隔 2 秒。Chat 原生输入框声明更低上限时，按较低上限分段。
- 转发前比对本房间近期的 Event Bridge 弹幕和插件已完成的转发。查重时长默认 60 秒，相似度默认 100%。命中时跳过发送并标为已读。开启双击强制发送时，提示消失后自动标记，也可在提示期间双击纸飞机继续转发。
- 转发时，每段提交以后等待同房间同文事件，收到后才继续。全部确认后将 SC 标为已读。单段超时会停止后续发送并提示核对公屏。若在同一时刻其他观众发送了相同的段落，它也可能被认作回执。

## 数据与权限

桥接服务只监听本机 `127.0.0.1`。由安装脚本生成的 `bridge-instance.json` 仅供扩展后台读取，由 Git 忽略。桥接弹幕缓存在内存中，最多保留最近一小时的 60,000 条；完整转发记录保留在浏览器会话内。转发由用户点击触发。 [LAPLACE 使用条款](https://laplace.live/tos)

## 许可

项目采用 [AGPL-3.0-only](LICENSE)。上游桥接程序及其发布版本见 [第三方软件说明](THIRD_PARTY_NOTICES.md)。
