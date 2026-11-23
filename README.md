# SC 转发扩展 for LAPLACE Chat

独立第三方 Chrome 和 Edge 扩展，适用于 `chat.laplace.live` 和 `laplace.chat` 的单房间控制台。在 SC 卡片右上角点纸飞机，即可用已验证的 B 站账号把该条正文发送成普通弹幕。

## 默认安装和连接（Windows x64）

1. 下载或克隆仓库，运行项目根目录的 [Install-SC-Relay.cmd](Install-SC-Relay.cmd)。脚本会下载并校验官方 Event Bridge 服务端、启动本机服务、写入插件的连接配置并打开 Chrome 扩展管理页。使用 Edge 时运行 `Install-SC-Relay.cmd -Browser Edge`。默认流程无需 Node.js。
2. 开启开发者模式，选择「加载已解压的扩展程序」，选中 `laplace-sc-replay` 文件夹。已安装时在扩展卡片上点击「重新加载」。 [Chrome 加载说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
3. 刷新 LAPLACE Chat，打开 **SC 栏齿轮 → 发送账号 → 弹幕事件 · Event Bridge**，点击「复制本机桥接密码」。在 **Chat 原生齿轮 → Event Bridge 集成** 填入 `127.0.0.1`、端口 `9696` 和密码，点击连接。可启用 Chat 的页面载入时自动连接。 [Event Bridge 官方文档](https://laplace.live/chat/event-bridge)
4. 回到插件的 Event Bridge 设置，从「本房间近期发言账号」选择 Chat 当前用于发弹幕的账号，或直接填写 UID，再保存。未看到自己的昵称时，可以在 Chat 原生输入框发一条普通弹幕后再选。出现实时弹幕计数后即可点 SC 的纸飞机。

Windows 重启后再次运行 `Install-SC-Relay.cmd` 即可启动服务，已有密码会复用。选择自建本机桥接时，在插件的「手动桥接配置」中填写端口和密码。已有账号绑定和手动桥接设置会被保留。

## 其他账号来源

### 本机 Login Sync

如需此方式，在安装了 Node.js 和 npm 的 Windows 上运行 `Install-SC-Relay.cmd -WithLoginSync`。

1. 在同一个浏览器窗口中登录想要保存的 B 站账号。在发送账号设置选择「本机 Login Sync」，点击「生成当前登录账号的密钥」。首次生成请按提示授权读取 B 站会话。
2. 密钥会自动填入「本机身份密钥」。点击「验证并记录」，核对显示的 B 站昵称和 UID。已有本机密钥也可以直接填入。
3. 登录另一个 B 站账号后重复上述步骤。用「已记录的账号」选择昵称，再点击「使用选中账号」。发送账号与网页当前登录分开，浏览器关闭后仍保留记录和选择。

服务只监听 `127.0.0.1:18188`，B 站会话以加密形式存于 `login-sync-local/data`。Windows 重启后用同一个 `-WithLoginSync` 参数启动服务。点击「检查会话」可以验证选中账号的状态。B 站会话失效时，在当前窗口重新登录该账号，选中对应记录并点击「更新会话」，即可用原密钥继续使用。需要保留多个账号的有效登录时，可分别在普通窗口和无痕窗口登录，避免主动退出 B 站。无痕窗口需要在浏览器扩展详情中允许本扩展运行。

### 已登录的 B 站会话

在想用于发送的窗口登录 B 站，点击「读取浏览器会话」，授权后选择对应的窗口。扩展使用你手动绑定的账号，并显示昵称和 UID。若要在同一个 Chrome 用户资料里同时登录两个账号，可分别使用普通窗口和无痕窗口。选择无痕窗口时，请在扩展详情中启用「在无痕模式下允许」，并保持至少一个无痕窗口打开。不同 Chrome 用户资料中的账号可以在各自的资料内安装和使用本扩展。 [Chrome 会话隔离说明](https://developer.chrome.com/docs/extensions/reference/api/cookies)

### LAPLACE Login Sync 身份密钥

在「账号来源」选择「LAPLACE Login Sync 身份密钥」，填写控制台原来用的同一个身份密钥。此来源连接 LAPLACE 默认同步服务器。若服务器要求额外读取授权，可在同一栏填写服务端签发的读取授权密钥。 [Login Sync 文档](https://laplace.live/login-sync) · [上游客户端授权说明](https://github.com/laplace-live/login-sync/tree/master/packages/login-sync#client)

## 默认发送方式

新安装默认使用「LAPLACE Chat 当前账号」。确认控制台左侧已显示原生发送框，留空后点击 SC 卡片上的纸飞机。插件会调用网页的原生表单，由 Chat 使用它当前的发送账号。若之前选过其他方式，可按「恢复默认账号」切回。 [LAPLACE 网站发送设置](https://laplace.live/settings)

插件按照设置的字符上限分段，每段都加上前后缀，再通过 Chat 逐段提交。若 Chat 输入框声明了更低的字符上限，插件也会遵守。用此账号方式时，请先配置下方的 Event Bridge。收到同房间、同发送账号 UID、同正文的实时事件后才继续发送，全部确认后标记为已读。

查重读取当前桥接连接收到的弹幕，最多保留最近一小时内的 60,000 条。若事件源没有提供真实 UID，Chat 当前账号模式无法确认发送，请检查控制台连接方式和登录同步。 [弹幕事件字段](https://chat.laplace.live/event-types/interfaces/Message.html)

## 使用

- 点击 SC 卡片上的纸飞机。齿轮可设置前缀、后缀、单条长度和自动分段间隔。前后缀默认分别为 `【` 和 `】`，可自行修改或清空。
- 长文优先按句末标点和逗号断开。每段计入前后缀，默认单条长度 20，间隔 2 秒。某段发送失败或结果无法确认时，停止剩余分段，并提示已经确认的条数。
- 转发前比对同房间的近期弹幕和本扩展已成功转发的 SC。齿轮可调整查重时长（默认 60 秒）和相似度阈值（默认 100%）。相似度按增、删、改字符的次数计算，达到阈值即跳过。分段须由同一发言者按顺序发齐。其他账号方式可以在桥接不可用时用左侧弹幕列表查重。成功转发记录在浏览器会话内保留，刷新控制台后仍可参与查重。
- 命中时提示会显示实际相似度并自动淡出。默认可在提示期间双击同一条 SC 的纸飞机继续转发，提示消失后自动标记已读。关闭设置中的「提示期间可双击强制发送」后，命中即标记已读。
- 全部分段发送成功后，扩展触发控制台原有的双击标已读操作。控制台接受时按现有已读设置变灰或隐藏，未接受时当前卡片由扩展显示为灰色。
- 使用「已登录的 B 站会话」时，如果该窗口切换了账号，扩展会暂停发送，直到重新绑定确认 UID。发送目标取自当前控制台房号，发送前由 B 站解析成实际房号。

## 发送链路

浏览器会话或 Login Sync 方式直接发送 B 站普通弹幕。后台从选中的浏览器会话取出该账号的 Cookie，或通过 Login Sync SDK 解密同步数据，随后核对 UID、解析房间号、提交表单并检查 B 站回执。实现参考了 [Chatterbox](https://laplace.live/chatterbox/copy-ninja) 的普通弹幕请求。

## 数据与权限

默认方式调用 Chat 的原生输入框发送，并通过本机 Event Bridge 接收弹幕。桥接端口只监听 `127.0.0.1`。安装脚本生成的 bridge-instance.json 只供扩展后台读取，并由 Git 忽略。近期弹幕保存在运行时内存，已完成的转发记录保留到浏览器会话结束。

浏览器会话和本机 Login Sync 方式在读取 B 站会话时请求 Cookie 权限。浏览器会话方式保存所选窗口标识和 UID，本机 Login Sync 将会话以密文保存在本机，外部同步方式将密钥和读取授权保存在浏览器会话中。账号核验和直接发送请求发往 B 站。

转发由用户点击触发。请按 LAPLACE 和 B 站的使用规则操作。 [LAPLACE 使用条款](https://laplace.live/tos)

## 许可和致谢

项目采用 [AGPL-3.0-only](LICENSE)。第三方软件版本、源码和许可见 [第三方软件说明](THIRD_PARTY_NOTICES.md)。
